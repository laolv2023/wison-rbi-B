// command_validator.js — 客户端命令白名单 + 深度校验器
//
// ## 模块角色 (§5.5 客户端设计 — 安全核心)
//   这是「不变量 1」的客户端强制执行者 (§2.2):
//   "客户端收到的每一个字节只能是合法 Skia 绘制命令（通过白名单校验）或帧元数据"
//
//   此模块是客户端安全架构的基石。它位于帧接收流水线的 CommandValidator 阶段
//   (在解压+CRC 之后，CanvasKit 渲染之前)，是所有命令的必经门禁。
//
// ## 威胁模型
//   假设攻击者已完全控制服务端，可以向客户端发送任意二进制数据伪装的"帧"。
//   此模块是纵深防御的最后一道防线：即使服务端发送恶意数据，客户端也只能执行
//   白名单内的合法 Skia 命令，且命令参数受到严格边界校验。
//
// ## 校验层级 (由外到内) — §8.4 安全边界
//   层级 1. Opcode 白名单: 仅允许 0x01-0x7F (白名单枚举)，≥0x80 一律拒绝
//   层级 2. Payload 大小: ≤ MAX_PAYLOAD_BYTES (1MB)
//   层级 3. 帧级总字节: ≤ MAX_BYTES_PER_FRAME (64MB) — v1.6 P0 S1 引入
//   层级 4. Save/Restore 配对: 深度计数平衡 (不配对 → 栈溢出/欠载)
//   层级 5. Payload 子结构深度校验: 防止 count 字段伪造导致 OOM (v1.6 增强)
//   层级 6. 缓冲区边界: 每条命令不超出帧边界 (越界读取 = 安全漏洞)
//   层级 7. 对齐填充校验: 每 4 字节对齐处的填充字节必须全为零
//   层级 8. 命令数量上限: ≤ MAX_COMMANDS_PER_FRAME (100k)
//   层级 9. Paint 内 Shader 子结构校验: colorCount 等 (Phase 2)
//
// ## 拒绝策略 (§8.1 / §8.4)
//   - 单次拒绝: 丢弃整个帧（原子性 — 不部分渲染），记录 WARN 日志
//   - 连续拒绝 ≥ 3 帧 (CONSECUTIVE_REJECT_THRESHOLD): 发送 request_keyframe
//     强制服务端发送关键帧以恢复同步
//   - 白名单外的 opcode: 立即拒绝（不尝试部分解析，避免解析器歧义）
//
// ## 设计文档交叉引用
//   - §2.2: 核心安全不变量 (不变量 1 的客户端表述)
//   - §5.5: 客户端帧处理流水线 (validator.validate 调用点)
//   - §6.2: 命令二进制格式 (opcode + payLen + payload + 对齐)
//   - §8.1: 错误处理 → 连续拒绝 → request_keyframe
//   - §8.4: 安全边界 (各硬上限的威胁模型依据)
//

'use strict';

import { PROTOCOL } from './protocol.js';
import { auditLog, LOG_LEVELS } from './utils.js';

/**
 * 命令白名单校验器。
 *
 * 实例化时机: 客户端初始化 (init 函数) 时创建单例，
 * 每帧调用 validate() 方法进行命令流校验。
 *
 * 状态管理: 维护 consecutiveRejects 跨帧计数器，
 * 用于检测持续攻击/损坏流并触发 request_keyframe。
 *
 * 安全设计原则:
 *   - Fail-Closed: 任何校验失败 → 丢弃整帧 (不尝试修复)
 *   - Defense in Depth: 9 层校验独立执行，前一层通过才能到下一层
 *   - No Partial Execution: 帧要么完全通过校验后渲染，要么完全不渲染
 */
class CommandValidator {
    /**
     * 初始化校验器。
     *
     * 构建白名单集合 (VALID_OPCODES) — 所有不在集合中的 opcode 值
     * 在 validate() 的第 1 层检查中会被立即拒绝。
     */
    constructor() {
        /**
         * Opcode 白名单 (Set)。
         * 包含 PROTOCOL.OPCODE 中定义的所有枚举值 (0x01-0x7F)。
         * 任何不在该集合中的 opcode 字节值 ⇒ 非法。
         *
         * 白名单策略 vs 黑名单策略:
         *   白名单 = 仅允许已知安全的 opcode
         *   黑名单 = 仅拒绝已知危险的 opcode
         *   白名单天生更安全 — 新 opcode 默认被拒绝。
         *
         * @type {Set<number>}
         */
        this.VALID_OPCODES = new Set(Object.values(PROTOCOL.OPCODE));
        // 语义冻结 — 虽然是 Set，但构造后不再修改
        Object.freeze(this.VALID_OPCODES);

        /**
         * 硬上限引用。
         * 从 PROTOCOL.LIMITS 复制以避免每次访问时的属性解析。
         * @type {object}
         */
        this.LIMITS = PROTOCOL.LIMITS;

        /**
         * 连续拒绝帧数计数器。
         *
         * 威胁模型: 攻击者持续发送恶意帧。单帧丢弃是正确行为，
         * 但连续拒绝可能表明 (a) 服务端被入侵发送攻击载荷 或
         * (b) 编解码器失同步。此时请求关键帧可恢复同步，
         * 若攻击持续则需运维介入。
         *
         * 在每次 validate() 成功时归零 (_resetRejects)。
         * @type {number}
         */
        this.consecutiveRejects = 0;  // 连续拒绝帧数

        /**
         * Opcode 值 → 人类可读名称的映射 (调试/审计用)。
         * @type {object}
         */
        this.OPCODE_NAMES = this._buildOpcodeNames();
    }

    /**
     * 验证完整帧的命令流。
     *
     * 这是校验流水线的主入口。对命令流逐条执行 9 层校验。
     *
     * 为什么逐条校验而非批量: 每条命令的长度取决于前一条的校验结果
     * (offset 前进)。批量校验需要两次遍历或预解析所有命令边界，
     * 实现复杂度高且无安全收益。
     *
     * 时间复杂度: O(N) 遍历命令流一次，O(M) 对每条含数组的 opcode
     * 进行子结构校验 (M ≤ N)。总体线性于帧大小。
     *
     * @param {ArrayBuffer} commandsBuffer - 命令流（不含帧头和 CRC Trailer）
     * @returns {{
     *   valid: boolean,
     *   commandCount?: number,
     *   rejectOffset?: number,
     *   rejectReason?: string,
     *   shouldRequestKeyframe?: boolean
     * }} 校验结果。valid=true 时可安全交给 renderFrame() 执行
     */
    validate(commandsBuffer) {
        // ── 空帧 = 合法帧 ──
        // 场景: 纯色页面无变化时服务端发送空命令流。
        if (!commandsBuffer || commandsBuffer.byteLength === 0) {
            this._resetRejects();
            return { valid: true, commandCount: 0 };
        }

        const view = new DataView(commandsBuffer);
        let offset = 0;
        let cmdCount = 0;
        let saveDepth = 0;         // Save/Restore 栈深度计数器
        let totalBytes = 0;        // 帧级累加 (v1.6 P0 S1)

        while (offset < commandsBuffer.byteLength) {
            // ── 检查 0: 是否有足够空间读取命令头 (4 bytes) ──
            // 威胁: 帧截断攻击 — 攻击者在命令中间截断帧，
            // 导致读取 opcode/payLen 时越界。
            if (offset + PROTOCOL.COMMAND_HEADER_SIZE > commandsBuffer.byteLength) {
                return this._reject(offset, 'Truncated command header');
            }

            // ── 读取命令头: opcode(1B) + payLen(3B, uint24 LE) ──
            const opcode = view.getUint8(offset);
            // payLen 为 3 字节小端序 uint24。JavaScript 没有 uint24 类型，
            // 使用按位或拼接。注意高位字节没有 & 0xFF (getUint8 保证返回 0-255)。
            const payLen = (view.getUint8(offset + 1) |
                           (view.getUint8(offset + 2) << 8) |
                           (view.getUint8(offset + 3) << 16));

            // ── 层级 1: Opcode 白名单 (§2.2 不变量 1) ──
            // 威胁: 攻击者发送 0x80-0xFF (非法 opcode)。
            // 为什么 ≥0x80 非法: 1) 预留空间，2) 最高位标记用于未来扩展，
            // 3) 防止与 ASCII 字符集混淆。
            if (!this.VALID_OPCODES.has(opcode)) {
                return this._reject(offset,
                    `Invalid opcode: 0x${opcode.toString(16).padStart(2, '0')} ` +
                    `(range: 0x01-0x7F, illegal ≥0x80)`);
            }

            // ── 层级 2: Payload 大小上限 ──
            // 威胁: 单条命令声明超大的 payload → 内存耗尽。
            // 1MB 上限远远超过任何合法 Skia 命令所需的 payload:
            //   - 最大合法命令: drawPath 含 100k verbs + 100k points ≈ 1.6MB
            //     (已在子结构校验中单独限制)
            //   - 其他命令通常 < 1KB
            if (payLen > this.LIMITS.MAX_PAYLOAD_BYTES) {
                return this._reject(offset,
                    `Payload too large: ${payLen} > ${this.LIMITS.MAX_PAYLOAD_BYTES}`);
            }

            // ── 层级 3: 帧级总字节硬上限 (v1.6 P0 S1) ──
            // 威胁: 攻击者发送大量小命令 (每条 < 1MB)，总帧大小 > 64MB。
            // v1.5 缺失此检查 — 100k × 1KB = 100MB 可通过所有其他校验。
            // v1.6 新增帧级累加器，逐命令累加并检查。
            totalBytes += PROTOCOL.COMMAND_HEADER_SIZE + payLen;
            if (totalBytes > this.LIMITS.MAX_BYTES_PER_FRAME) {
                return this._reject(offset,
                    `Frame total bytes ${totalBytes} exceeds ` +
                    `MAX_BYTES_PER_FRAME (${this.LIMITS.MAX_BYTES_PER_FRAME})`);
            }

            // ── 层级 6: 缓冲区边界校验 ──
            // 威胁: payLen 声明值超出帧剩余空间 → 越界读取。
            // 此检查必须在校验 1 (opcode 白名单) 之后、校验 4/5 之前，
            // 确保后续 payload 子结构解析不会触发越界访问。
            if (offset + PROTOCOL.COMMAND_HEADER_SIZE + payLen > commandsBuffer.byteLength) {
                return this._reject(offset,
                    `Payload overflows buffer: offset=${offset}, payLen=${payLen}, ` +
                    `bufferLen=${commandsBuffer.byteLength}`);
            }

            // ── 层级 4: Save/Restore 配对 ──
            // 威胁: 不配对的 save/restore 导致 CanvasKit 内部栈:
            //   - saveDepth < 0 (过多 restore) → 栈欠载 → 未定义行为/崩溃
            //   - saveDepth > 0 (过多 save) → 栈泄漏 → 内存膨胀
            // 在帧内逐条实时跟踪，帧结束时最终检查。
            if (opcode === PROTOCOL.OPCODE.SAVE || opcode === PROTOCOL.OPCODE.SAVE_LAYER) {
                saveDepth++;
            }
            if (opcode === PROTOCOL.OPCODE.RESTORE) {
                saveDepth--;
                // 帧中 restore 过多: 立即拒绝，不等到帧末
                if (saveDepth < 0) {
                    return this._reject(offset, 'Unbalanced restore: saveDepth < 0');
                }
            }

            // ── 层级 5: Payload 子结构深度检查 (v1.6) ──
            // 威胁: 攻击者通过合法的 payLen (如 500KB) 包裹一个伪造的
            // pointCount=10亿 来触发客户端内存分配 OOM。
            // 本方法对每个包含数组计数的 opcode，提取 count 并验证
            // count × element_size ≤ actual_payLen。
            // 原理见 _validatePayloadSubstructure 的 Threat Model 注释。
            if (payLen > 0) {
                const payloadSlice = new DataView(
                    commandsBuffer,
                    offset + PROTOCOL.COMMAND_HEADER_SIZE,
                    payLen
                );
                const subResult = this._validatePayloadSubstructure(
                    opcode, payLen, payloadSlice
                );
                if (!subResult.valid) {
                    return this._reject(offset, subResult.reason);
                }
            }

            // ── 层级 8: 命令数量上限 ──
            // 威胁: 攻击者发送 100k+ 条 NOOP 命令 (每条 4 字节头，无 payload)。
            // 即使帧总字节在 64MB 内，100k 次 dispatchOpcode 调用
            // 也会造成严重的 CPU 消耗 (拒绝服务)。
            if (cmdCount >= this.LIMITS.MAX_COMMANDS_PER_FRAME) {
                return this._reject(offset,
                    `Too many commands: ${cmdCount} >= ${this.LIMITS.MAX_COMMANDS_PER_FRAME}`);
            }

            // ── 前进到下一命令 ──
            offset += PROTOCOL.COMMAND_HEADER_SIZE + payLen;
            cmdCount++;

            // ── 层级 7: 4 字节对齐 + 填充零校验 ──
            // 威胁: 攻击者可在对齐填充字节中嵌入隐藏数据/指令。
            // 强制要求填充字节必须全为零，否则视为恶意篡改。
            // 对齐填充字节在服务端 endCommand 时写入，客户端此处校验。
            const remainder = offset % PROTOCOL.COMMAND_ALIGNMENT;
            if (remainder !== 0) {
                const pad = PROTOCOL.COMMAND_ALIGNMENT - remainder;
                // 验证每个对齐填充字节是否为零
                for (let i = 0; i < pad && offset + i < commandsBuffer.byteLength; i++) {
                    if (view.getUint8(offset + i) !== 0) {
                        return this._reject(offset,
                            `Non-zero alignment padding at offset ${offset + i}`);
                    }
                }
                offset += pad;
            }
        }

        // ── 层级 4 (续): 帧末 Save/Restore 平衡检查 ──
        // saveDepth > 0 在此处检测 (帧内过少的 restore)。
        if (saveDepth !== 0) {
            return this._reject(offset,
                `Unbalanced save/restore: saveDepth=${saveDepth} at end of frame`);
        }

        // ── 全部通过 ──
        // 重置连续拒绝计数器 — 此帧合法，恢复计数
        this._resetRejects();
        return { valid: true, commandCount: cmdCount };
    }

    // ═══════════════════════════════════════════════════════════
    // Payload 子结构深度校验 (v1.6 增强)
    //
    // ## 威胁模型
    //   攻击者构造合法的 opcode + payLen (如 500KB DRAW_PATH)，
    //   但在 payload 内部的 verbCount/pointCount 字段写入极端值 (如 10亿)。
    //   若客户端使用恶意 count 来预分配数组 (new Float32Array(maliciousCount*2))，
    //   将立即 OOM 或触发浏览器 WASM 内存限制错误。
    //
    //   防御:
    //   对每个已知包含数组计数的 opcode，提取 count 值：
    //     1. count ≤ 对应硬上限 (如 MAX_PATH_VERBS = 100k)
    //     2. count × element_size ≤ payLen (结构必须完整嵌入 payload)
    //
    //   注意: minSize ≤ payLen 检查使用「≥」而非「==」，允许 payload 包含
    //   额外的尾部数据 (如 Paint 紧跟路径数据之后)。
    //
    //   每个 case 的 minSize 计算公式:
    //     minSize = header_size + Σ(count_i × element_size_i)
    //   例如 DRAW_PATH: 8 (verbCount + pointCount) + verbCount×1 + pointCount×8
    // ═══════════════════════════════════════════════════════════

    /**
     * 对 payload 内部结构进行深度校验。
     *
     * 仅对已知包含 count 字段的 opcode 执行检查。
     * 未知 opcode 跳过子结构校验 (已在 layer 1 白名单校验中拒绝)。
     *
     * @private
     * @param {number} opcode - 命令操作码
     * @param {number} payLen - payload 总字节数
     * @param {DataView} payload - payload 的 DataView
     * @returns {{ valid: boolean, reason?: string }}
     */
    _validatePayloadSubstructure(opcode, payLen, payload) {
        const OP = PROTOCOL.OPCODE;

        switch (opcode) {
            // ── drawPath (0x35): verbCount(4) + pointCount(4) + verbs[] + points[] ──
            // 威胁: verbCount/pointCount 炸弹 → 读取超大数据 → OOM/超时
            // 防御: verbCount ≤ 100k, pointCount ≤ 100k, 且 minSize ≤ payLen
            case OP.DRAW_PATH: {
                if (payLen < 8) return this._subReject('drawPath: payload too short for counts');
                const verbCount  = payload.getUint32(0, true);
                const pointCount = payload.getUint32(4, true);

                if (verbCount > this.LIMITS.MAX_PATH_VERBS) {
                    return this._subReject(`drawPath: verbCount ${verbCount} > ${this.LIMITS.MAX_PATH_VERBS}`);
                }
                if (pointCount > this.LIMITS.MAX_PATH_VERBS) {
                    return this._subReject(`drawPath: pointCount ${pointCount} > ${this.LIMITS.MAX_PATH_VERBS}`);
                }
                // verbs: 1 byte each; points: 2×f32 each = 8 bytes
                const minSize = 8 + verbCount + pointCount * 8;
                if (minSize > payLen) {
                    return this._subReject(`drawPath: sub-structure overflow (need ${minSize}, have ${payLen})`);
                }
                break;
            }

            // ── drawPoints (0x36): mode(1) + count(4) + points(count × 2×f32) ──
            // 威胁: count 炸弹 → 超大量点坐标
            case OP.DRAW_POINTS: {
                if (payLen < 5) return this._subReject('drawPoints: payload too short');
                const count = payload.getUint32(1, true);   // count 在 offset 1 (mode 占 1B)
                if (count > this.LIMITS.MAX_PATH_VERBS) {
                    return this._subReject(`drawPoints: count ${count} > ${this.LIMITS.MAX_PATH_VERBS}`);
                }
                const minSize = 5 + count * 8;              // mode(1) + count(4) + count×(2×f32)
                if (minSize > payLen) {
                    return this._subReject(`drawPoints: sub-structure overflow (need ${minSize}, have ${payLen})`);
                }
                break;
            }

            // ── drawAtlas (0x43): count(4) + RSXform(16) + tex(16) + colors(4) per sprite ──
            // 威胁: atlas sprite 炸弹 → 超大量图集条目
            case OP.DRAW_ATLAS: {
                if (payLen < 4) return this._subReject('drawAtlas: payload too short');
                const count = payload.getUint32(0, true);
                if (count > this.LIMITS.MAX_ATLAS_COUNT) {
                    return this._subReject(`drawAtlas: count ${count} > ${this.LIMITS.MAX_ATLAS_COUNT}`);
                }
                // 粗略下界: count × (xform 16B + tex 16B + color 4B) = 36B per sprite
                // 注意: paint 和采样器参数在 count×36 之后，所以 minSize 是下界
                const minSize = 4 + count * 36;
                if (minSize > payLen) {
                    return this._subReject(`drawAtlas: sub-structure overflow (need ≥${minSize}, have ${payLen})`);
                }
                break;
            }

            // ── drawTextBlob (0x50): tx(4)+ty(4)+glyphCount(4)+glyphs(glyphCount×2)+positions(glyphCount×2×f32) ──
            // 威胁: glyphCount 炸弹 → 字形数量和位置数组溢出
            case OP.DRAW_TEXT_BLOB: {
                if (payLen < 12) return this._subReject('drawTextBlob: payload too short');
                const glyphCount = payload.getUint32(8, true);  // glyphCount 在 offset 8 (tx, ty 各 4B)
                if (glyphCount > this.LIMITS.MAX_TEXT_BLOB_GLYPHS) {
                    return this._subReject(`drawTextBlob: glyphCount ${glyphCount} > ${this.LIMITS.MAX_TEXT_BLOB_GLYPHS}`);
                }
                // 12 header + glyphCount * 2 (glyph IDs, uint16) + glyphCount * 8 (positions, 2×f32)
                const minSize = 12 + glyphCount * 10;
                if (minSize > payLen) {
                    return this._subReject(`drawTextBlob: sub-structure overflow (need ${minSize}, have ${payLen})`);
                }
                break;
            }

            // ── drawVerticesObject (0x63): mode(1) + vertexCount(4) + indexCount(4) + ... ──
            // 威胁: vertexCount/indexCount 炸弹 → 超大量顶点/索引数据
            case OP.DRAW_VERTICES_OBJECT: {
                if (payLen < 9) return this._subReject('drawVertices: payload too short');
                const vertexCount = payload.getUint32(1, true);
                const indexCount  = payload.getUint32(5, true);
                if (vertexCount > this.LIMITS.MAX_VERTICES_COUNT) {
                    return this._subReject(`drawVertices: vertexCount ${vertexCount} > ${this.LIMITS.MAX_VERTICES_COUNT}`);
                }
                if (indexCount > this.LIMITS.MAX_VERTICES_COUNT) {
                    return this._subReject(`drawVertices: indexCount ${indexCount} > ${this.LIMITS.MAX_VERTICES_COUNT}`);
                }
                // 粗略下界: 9 header + vertices × 8 (pos 2×f32) + indices × 2 (uint16)
                // 未含颜色/纹理坐标 — 实际 minSize 更大，此为安全下界
                const minSize = 9 + vertexCount * 8 + indexCount * 2;
                if (minSize > payLen) {
                    return this._subReject(`drawVertices: sub-structure overflow (need ≥${minSize}, have ${payLen})`);
                }
                break;
            }

            // ── drawImage (0x40) / drawImageRect (0x41): 图像数据标记格式校验 ──
            // 威胁: 未知/伪造的图像标记 → 渲染错误/资源泄漏
            case OP.DRAW_IMAGE:
            case OP.DRAW_IMAGE_RECT: {
                // 图像数据标记格式 (§4.1.4):
                //   flag(1B): 0x01 = hash-ref (SHA-256, 32B), 0x00 = inline (raw data)
                if (payLen < 1) return this._subReject('drawImage: payload too short');
                const flag = payload.getUint8(0);
                if (flag === 0x01) {
                    // hash-ref: 需要 flag(1B) + hash(32B) = 33B 最低
                    if (payLen < 33) return this._subReject('drawImage: hash-ref too short');
                } else if (flag === 0x00) {
                    // inline: flag(1B) + slot_id(4B) 最低 = 5B
                    if (payLen < 5) return this._subReject('drawImage: inline too short');
                } else {
                    // 未知的 flag 值 — 可能为未来扩展或攻击
                    return this._subReject(`drawImage: unknown image flag ${flag}`);
                }
                break;
            }

            // ── fontData (0x70): font_id(4) + size(4) + data(N) ──
            // 威胁: size 字段伪造 → 读取 fontData 时越界
            // 防御: size ≤ MAX_FONT_INLINE_BYTES (5MB) 且 8+size ≤ payLen
            case OP.FONT_DATA: {
                if (payLen < 8) return this._subReject('fontData: payload too short');
                const fontSize = payload.getUint32(4, true);
                if (fontSize > this.LIMITS.MAX_FONT_INLINE_BYTES) {
                    return this._subReject(`fontData: font size ${fontSize} > ${this.LIMITS.MAX_FONT_INLINE_BYTES}`);
                }
                if (8 + fontSize > payLen) {
                    return this._subReject(`fontData: sub-structure overflow (need ${8 + fontSize}, have ${payLen})`);
                }
                break;
            }

            // ── 含 Paint 的绘制命令: 校验 Paint 内的 Shader 子结构 (Phase 2) ──
            // 威胁: Shader 中的 colorCount 字段可能伪造 → OOM
            // 防御: 递归调用 _validatePaintShader 检查 Shader 子结构的完整性
            case OP.DRAW_RECT:
            case OP.DRAW_RRECT:
            case OP.DRAW_OVAL:
            case OP.DRAW_ARC:
            case OP.DRAW_PATH:
            case OP.DRAW_PAINT:
            case OP.DRAW_SHADOW: {
                // Paint 在 payload 中的偏移因命令而异:
                //   DRAW_RECT:  rect(16B) + paint → paint@16
                //   DRAW_RRECT: rrect(12×f32 + 1B type = 49B) + paint → paint@49
                //   DRAW_OVAL:  rect(16B) + paint → paint@16
                //   DRAW_ARC:   rect(16B) + startAngle(4B) + sweepAngle(4B) = 24B? 实际需确认
                //   DRAW_PATH:  path(变长) — 偏移不固定，跳过 Shader 校验
                //   DRAW_PAINT: paint@0 (整个 payload 就是 Paint)
                //   DRAW_SHADOW: paint@0 (整个 payload 就是 Paint)
                //   DRAW_PAINT 和 DRAW_SHADOW 无几何体，仅 Paint 数据

                let paintOffset = -1;  // -1 表示不校验 (如变长路径)
                if (opcode === OP.DRAW_PAINT || opcode === OP.DRAW_SHADOW) {
                    paintOffset = 0;        // 无几何体，Paint 在 payload 起始
                } else if (opcode === OP.DRAW_RECT || opcode === OP.DRAW_OVAL) {
                    paintOffset = 16;       // 16B rect (x,y,w,h 各 f32)
                } else if (opcode === OP.DRAW_RRECT) {
                    paintOffset = 49;       // 12×f32 + 1B type = 49B (含 1B 类型标记)
                } else if (opcode === OP.DRAW_ARC) {
                    paintOffset = 20;       // rect(16B) + startAngle(4B) = 20B (sweepAngle 在 Paint 后)
                }
                // DRAW_PATH: paint 在 path verbs 末尾，偏移不固定，跳过 Shader 校验
                // (path 子结构已在 drawPath case 中校验)
                if (paintOffset >= 0 && payLen >= paintOffset + 19) {
                    // 需要至少 19 字节 — Paint 固定头 (18B) + has_shader (1B)
                    const shaderResult = this._validatePaintShader(
                        payload, paintOffset, payLen
                    );
                    if (!shaderResult.valid) return shaderResult;
                }
                break;
            }

            default:
                // 其他 opcode 当前不需要深度子结构校验。
                // 新 opcode 添加到 PROTOCOL.OPCODE 时需评估是否需要在此添加校验。
                break;
        }

        return { valid: true };
    }

    // ═══════════════════════════════════════════════════════════
    // Paint 内 Shader 子结构校验 (Phase 2)
    //
    // ## 威胁模型
    //   攻击者在 Paint 数据中嵌入 Shader，其 colorCount 字段伪造为
    //   极大值 (如 0xFF = 255)。虽然 MAX_GRADIENT_COLORS=32 限制了
    //   正常使用，但攻击者可能直接发送 colorCount=255。
    //   本函数在 Paint 二进制格式中找到 Shader 子结构，
    //   验证 shader_type 合法、header 不越界、colorCount ≤ 32、
    //   且颜色表大小与 payLen 一致。
    //
    //   Paint 二进制格式 (§6.2 / §4.1.3):
    //     [0:4]   color RGBA uint32 LE
    //     [4:8]   stroke_width float32 LE
    //     [8]     style (0=Fill, 1=Stroke, 2=StrokeAndFill)
    //     [9]     cap
    //     [10]    join
    //     [11]    _pad (对齐)
    //     [12:16] miter_limit float32 LE
    //     [16]    blend_mode
    //     [17]    anti_alias
    //     [18]    has_shader (0=无, 1=有)
    //     [19]    shader_type (if has_shader)
    //     [20+]   shader_data (variable, if has_shader):
    //               几何参数 + tileMode(1B) + colorCount(1B) + 2B_pad
    //               + colorCount × 8B (RGBA u32 + position f32)
    // ═══════════════════════════════════════════════════════════

    /**
     * 校验 Paint 内的 Shader 子结构。
     *
     * @private
     * @param {DataView} payload - 包含 Paint 的 payload
     * @param {number} paintOffset - Paint 在 payload 中的起始字节偏移
     * @param {number} payLen - payload 总字节数
     * @returns {{ valid: boolean, reason?: string }}
     */
    _validatePaintShader(payload, paintOffset, payLen) {
        // has_shader 在 Paint 固定头偏移 18 处
        const hasShader = payload.getUint8(paintOffset + 18);

        if (!hasShader) return { valid: true };  // 无 Shader → 合法

        // 需要至少 18B paint header + 1B has_shader + 1B shader_type = 20B
        if (paintOffset + 20 > payLen) {
            return this._subReject('Paint: payload too short for shader header');
        }

        // shader_type 在 paintOffset + 19 (has_shader 之后)
        const shaderOffset = paintOffset + 19;
        const shaderType = payload.getUint8(shaderOffset);

        // 检查 shader_type 是否为已知类型
        const HEADER = PROTOCOL.SHADER_HEADER_SIZE;
        if (!(shaderType in HEADER)) {
            return this._subReject(`Paint: unknown shader type 0x${shaderType.toString(16)}`);
        }

        const headerSize = HEADER[shaderType];

        // 检查 shader 头部不会越界
        if (shaderOffset + headerSize > payLen) {
            return this._subReject(
                `Paint: shader header overflow (type=${shaderType}, need ≥${shaderOffset + headerSize}, have ${payLen})`
            );
        }

        // colorCount 在 shader header 末尾前第 3 个字节 (header 尾部布局固定)
        // header 结构: [几何参数...] + tileMode(1B) + colorCount(1B) + _pad(2B)
        // 所以 colorCount 在 shaderOffset + headerSize - 3
        const colorCount = payload.getUint8(shaderOffset + headerSize - 3);
        const MAX = PROTOCOL.MAX_GRADIENT_COLORS;  // 32

        if (colorCount > MAX) {
            return this._subReject(
                `Paint: shader colorCount ${colorCount} > MAX_GRADIENT_COLORS (${MAX})`
            );
        }

        // 验证颜色表大小与 payload 空间一致
        // 每对: RGBA(4B) + position(4B) = 8B
        const colorTableSize = colorCount * 8;
        const totalShaderSize = headerSize + colorTableSize;
        if (shaderOffset + totalShaderSize > payLen) {
            return this._subReject(
                `Paint: shader color table overflow (need ${totalShaderSize}, have ${payLen - shaderOffset})`
            );
        }

        return { valid: true };
    }

    // ═══════════════════════════════════════════════════════════
    // 拒绝处理
    //
    // 拒绝策略 (§8.4):
    //   - 自增 consecutiveRejects (跨帧计数器)
    //   - 记录 WARN 日志 (含 offset + reason)
    //   - 若达到连续拒绝阈值 → shouldRequestKeyframe=true
    // ═══════════════════════════════════════════════════════════

    /**
     * 命令级拒绝: 记录并返回拒绝结果。
     *
     * 副作用:
     *   - consecutiveRejects 自增 (跨帧状态)
     *   - WARN 级别审计日志
     *
     * @private
     * @param {number} offset - 拒绝发生时的字节偏移
     * @param {string} reason - 拒绝原因 (人类可读)
     * @returns {{ valid: false, rejectOffset: number, rejectReason: string, shouldRequestKeyframe: boolean }}
     */
    _reject(offset, reason) {
        this.consecutiveRejects++;

        auditLog(LOG_LEVELS.WARN, 'command_reject', {
            offset,
            reason,
            consecutiveRejects: this.consecutiveRejects,
        });

        const shouldRequestKeyframe =
            this.consecutiveRejects >= this.LIMITS.CONSECUTIVE_REJECT_THRESHOLD;

        return {
            valid: false,
            rejectOffset: offset,
            rejectReason: reason,
            shouldRequestKeyframe,
        };
    }

    /**
     * 子结构拒绝: 返回校验失败结果 (不自增 consecutiveRejects)。
     *
     * 子结构拒绝是单命令级的，不表示帧整体有问题 —
     * consecutiveRejects 由 _reject (帧级拒绝) 负责自增。
     *
     * @private
     * @param {string} reason
     * @returns {{ valid: false, reason: string }}
     */
    _subReject(reason) {
        return { valid: false, reason };
    }

    /**
     * 重置连续拒绝计数。
     *
     * 在 validate() 成功时调用 — 成功帧表示流未损坏/未受攻击。
     *
     * @private
     */
    _resetRejects() {
        if (this.consecutiveRejects > 0) {
            this.consecutiveRejects = 0;
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Opcode 名字映射（调试/审计）
    //
    // 为每个 opcode 值生成人类可读名称，用于日志和错误消息。
    // 例如: 0x35 → "DRAW_PATH"
    // ═══════════════════════════════════════════════════════════

    /**
     * 构建 opcode 值 → 名称映射表。
     *
     * @private
     * @returns {object} { 0x01: 'SAVE', 0x02: 'RESTORE', ... }
     */
    _buildOpcodeNames() {
        const names = {};
        const OP = PROTOCOL.OPCODE;
        for (const [key, value] of Object.entries(OP)) {
            names[value] = key;
        }
        return names;
    }

    /**
     * 获取 opcode 的人类可读名称。
     *
     * @param {number} opcode - opcode 值
     * @returns {string} 如 "DRAW_PATH" 或 "UNKNOWN(0xFF)"
     */
    getOpcodeName(opcode) {
        return this.OPCODE_NAMES[opcode] || `UNKNOWN(0x${opcode.toString(16)})`;
    }
}

export { CommandValidator };
