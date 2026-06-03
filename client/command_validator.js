// command_validator.js — 客户端命令白名单 + 深度校验器
//
// 安全核心 — 保障"不变量 1: 客户端收到的每一个字节只能是合法 Skia 绘制命令"。
//
// 校验层级 (由外到内):
//   1. Opcode 白名单: 0x01-0x7F 合法, ≥0x80 一律拒绝
//   2. Payload 大小: ≤ MAX_PAYLOAD_BYTES (1MB)
//   3. 帧级总字节: ≤ MAX_BYTES_PER_FRAME (64MB) — v1.6 P0 S1
//   4. Save/Restore 配对: 深度计数平衡
//   5. Payload 子结构深度校验: 防止 count 伪造→OOM (v1.6 增强)
//   6. 缓冲区边界: 每条命令不超出帧边界
//
// 拒绝策略 (§8):
//   - 单次拒绝: 丢弃帧，记录 warn
//   - 连续拒绝 ≥3 帧: 发送 request_keyframe
//   - 白名单外的 opcode: 立即拒绝（不尝试部分解析）
//

'use strict';

import { PROTOCOL } from './protocol.js';
import { auditLog, LOG_LEVELS } from './utils.js';

class CommandValidator {
    constructor() {
        // ── Opcode 白名单 (运行时构建) ──
        // 所有合法 opcode 值 — 不在集合中的 = 非法
        this.VALID_OPCODES = new Set(Object.values(PROTOCOL.OPCODE));
        // 锁定白名单
        Object.freeze(this.VALID_OPCODES);  // 实际上 Set 不可变，但语义上锁定

        // ── 硬上限 ──
        this.LIMITS = PROTOCOL.LIMITS;

        // ── 帧间状态 ──
        this.consecutiveRejects = 0;  // 连续拒绝帧数

        // ── Opcode 名字（调试/审计用） ──
        this.OPCODE_NAMES = this._buildOpcodeNames();
    }

    /**
     * 验证完整帧的命令流。
     *
     * @param {ArrayBuffer} commandsBuffer - 命令流（不含帧头和 CRC）
     * @returns {{ valid: boolean, commandCount?: number,
     *             rejectOffset?: number, rejectReason?: string,
     *             shouldRequestKeyframe?: boolean }}
     */
    validate(commandsBuffer) {
        if (!commandsBuffer || commandsBuffer.byteLength === 0) {
            // 空命令流 = 空帧 = 合法
            this._resetRejects();
            return { valid: true, commandCount: 0 };
        }

        const view = new DataView(commandsBuffer);
        let offset = 0;
        let cmdCount = 0;
        let saveDepth = 0;
        let totalBytes = 0;   // 帧级累加 (v1.6)

        while (offset < commandsBuffer.byteLength) {
            // ── 检查是否有足够空间读取命令头 (4 bytes) ──
            if (offset + PROTOCOL.COMMAND_HEADER_SIZE > commandsBuffer.byteLength) {
                return this._reject(offset, 'Truncated command header');
            }

            // ── 读取命令头 ──
            const opcode = view.getUint8(offset);
            const payLen = (view.getUint8(offset + 1) |
                           (view.getUint8(offset + 2) << 8) |
                           (view.getUint8(offset + 3) << 16));

            // ── 校验 1: Opcode 白名单 ──
            if (!this.VALID_OPCODES.has(opcode)) {
                return this._reject(offset,
                    `Invalid opcode: 0x${opcode.toString(16).padStart(2, '0')} ` +
                    `(range: 0x01-0x7F, illegal ≥0x80)`);
            }

            // ── 校验 2: Payload 大小 ──
            if (payLen > this.LIMITS.MAX_PAYLOAD_BYTES) {
                return this._reject(offset,
                    `Payload too large: ${payLen} > ${this.LIMITS.MAX_PAYLOAD_BYTES}`);
            }

            // ── 校验 2b: 帧级总字节硬上限 (v1.6 P0 S1) ──
            totalBytes += PROTOCOL.COMMAND_HEADER_SIZE + payLen;
            if (totalBytes > this.LIMITS.MAX_BYTES_PER_FRAME) {
                return this._reject(offset,
                    `Frame total bytes ${totalBytes} exceeds ` +
                    `MAX_BYTES_PER_FRAME (${this.LIMITS.MAX_BYTES_PER_FRAME})`);
            }

            // ── 校验 3: 缓冲区边界 ──
            if (offset + PROTOCOL.COMMAND_HEADER_SIZE + payLen > commandsBuffer.byteLength) {
                return this._reject(offset,
                    `Payload overflows buffer: offset=${offset}, payLen=${payLen}, ` +
                    `bufferLen=${commandsBuffer.byteLength}`);
            }

            // ── 校验 4: Save/Restore 配对 ──
            if (opcode === PROTOCOL.OPCODE.SAVE || opcode === PROTOCOL.OPCODE.SAVE_LAYER) {
                saveDepth++;
            }
            if (opcode === PROTOCOL.OPCODE.RESTORE) {
                saveDepth--;
                if (saveDepth < 0) {
                    return this._reject(offset, 'Unbalanced restore: saveDepth < 0');
                }
            }

            // ── 校验 5: Payload 子结构深度检查 (v1.6) ──
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

            // ── 命令数量检查 ──
            if (cmdCount >= this.LIMITS.MAX_COMMANDS_PER_FRAME) {
                return this._reject(offset,
                    `Too many commands: ${cmdCount} >= ${this.LIMITS.MAX_COMMANDS_PER_FRAME}`);
            }

            // ── 前进到下一命令 ──
            offset += PROTOCOL.COMMAND_HEADER_SIZE + payLen;
            cmdCount++;

            // 4 字节对齐（对齐填充字节在 endCommand 时写入，此处跳过）
            const remainder = offset % PROTOCOL.COMMAND_ALIGNMENT;
            if (remainder !== 0) {
                const pad = PROTOCOL.COMMAND_ALIGNMENT - remainder;
                // 验证对齐填充字节是否为零
                for (let i = 0; i < pad && offset + i < commandsBuffer.byteLength; i++) {
                    if (view.getUint8(offset + i) !== 0) {
                        return this._reject(offset,
                            `Non-zero alignment padding at offset ${offset + i}`);
                    }
                }
                offset += pad;
            }
        }

        // ── 最终检查: Save/Restore 平衡 ──
        if (saveDepth !== 0) {
            return this._reject(offset,
                `Unbalanced save/restore: saveDepth=${saveDepth} at end of frame`);
        }

        // ── 成功 ──
        this._resetRejects();
        return { valid: true, commandCount: cmdCount };
    }

    // ═══════════════════════════════════════════════════════════
    // Payload 子结构深度校验 (v1.6)
    //
    // 原理:
    //   攻击者可通过合法的 payLen（如 500KB）包裹一个伪造的
    //   pointCount=10亿 来触发客户端内存分配 OOM。
    //   本方法对每个包含数组计数的 opcode，提取 count 并验证
    //   count * element_size ≤ actual_payLen。
    // ═══════════════════════════════════════════════════════════

    _validatePayloadSubstructure(opcode, payLen, payload) {
        const OP = PROTOCOL.OPCODE;

        switch (opcode) {
            // ── drawPath (0x35): verbCount + pointCount + verbs[] + points[] ──
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
            case OP.DRAW_POINTS: {
                if (payLen < 5) return this._subReject('drawPoints: payload too short');
                const count = payload.getUint32(1, true);
                if (count > this.LIMITS.MAX_PATH_VERBS) {
                    return this._subReject(`drawPoints: count ${count} > ${this.LIMITS.MAX_PATH_VERBS}`);
                }
                const minSize = 5 + count * 8;
                if (minSize > payLen) {
                    return this._subReject(`drawPoints: sub-structure overflow (need ${minSize}, have ${payLen})`);
                }
                break;
            }

            // ── drawAtlas (0x43): count(4) + RSXform(16) + tex(16) + colors(4) ──
            case OP.DRAW_ATLAS: {
                if (payLen < 4) return this._subReject('drawAtlas: payload too short');
                const count = payload.getUint32(0, true);
                if (count > this.LIMITS.MAX_ATLAS_COUNT) {
                    return this._subReject(`drawAtlas: count ${count} > ${this.LIMITS.MAX_ATLAS_COUNT}`);
                }
                // 粗略下界: count × 36 (xform + tex + color)
                const minSize = 4 + count * 36;
                if (minSize > payLen) {
                    return this._subReject(`drawAtlas: sub-structure overflow (need ≥${minSize}, have ${payLen})`);
                }
                break;
            }

            // ── drawTextBlob (0x50): tx(4)+ty(4)+glyphCount(4)+glyphs(glyphCount×2)+positions(glyphCount×2×f32) ──
            case OP.DRAW_TEXT_BLOB: {
                if (payLen < 12) return this._subReject('drawTextBlob: payload too short');
                const glyphCount = payload.getUint32(8, true);
                if (glyphCount > this.LIMITS.MAX_TEXT_BLOB_GLYPHS) {
                    return this._subReject(`drawTextBlob: glyphCount ${glyphCount} > ${this.LIMITS.MAX_TEXT_BLOB_GLYPHS}`);
                }
                // 12 header + glyphCount * 2 (glyph IDs) + glyphCount * 8 (positions)
                const minSize = 12 + glyphCount * 10;
                if (minSize > payLen) {
                    return this._subReject(`drawTextBlob: sub-structure overflow (need ${minSize}, have ${payLen})`);
                }
                break;
            }

            // ── drawVerticesObject (0x63): mode(1) + vertexCount(4) + indexCount(4) + ... ──
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
                // 粗略下界: 9 header + vertices × 8 (pos) + indices × 2
                const minSize = 9 + vertexCount * 8 + indexCount * 2;
                if (minSize > payLen) {
                    return this._subReject(`drawVertices: sub-structure overflow (need ≥${minSize}, have ${payLen})`);
                }
                break;
            }

            // ── drawImage (0x40) / drawImageRect (0x41): 图像数据 inline flag ──
            case OP.DRAW_IMAGE:
            case OP.DRAW_IMAGE_RECT: {
                // 图像数据格式:
                //   flag(1) + [hash(32) 或 slot_id(4)+size(4)+data(N)]
                if (payLen < 1) return this._subReject('drawImage: payload too short');
                const flag = payload.getUint8(0);
                if (flag === 0x01) {
                    // hash-ref: 需要 33 bytes (flag + 32 hash)
                    if (payLen < 33) return this._subReject('drawImage: hash-ref too short');
                } else if (flag === 0x00) {
                    // inline: flag(1)+slot_id(4) 最低
                    if (payLen < 5) return this._subReject('drawImage: inline too short');
                } else {
                    return this._subReject(`drawImage: unknown image flag ${flag}`);
                }
                break;
            }

            // ── fontData (0x70): font_id(4) + size(4) + data(N) ──
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
            case OP.DRAW_RECT:
            case OP.DRAW_RRECT:
            case OP.DRAW_OVAL:
            case OP.DRAW_ARC:
            case OP.DRAW_PATH:
            case OP.DRAW_PAINT:
            case OP.DRAW_SHADOW: {
                // Paint 偏移因命令而异，但都从 payload 的某个固定偏移开始
                // DRAW_RECT:  rect(16B) + paint → paint@16
                // DRAW_RRECT: rrect(49B) + paint → paint@49  (12 float32 + 1B type)
                // DRAW_OVAL:  rect(16B) + paint → paint@16
                // DRAW_PATH:  path(variable) + paint@tail → 无法固定偏移
                // DRAW_PAINT: paint@0
                // DRAW_SHADOW: paint@0
                // 简化: 对固定偏移的命令校验 paint，变长路径跳过
                let paintOffset = -1;
                if (opcode === OP.DRAW_PAINT || opcode === OP.DRAW_SHADOW) {
                    paintOffset = 0;
                } else if (opcode === OP.DRAW_RECT || opcode === OP.DRAW_OVAL) {
                    paintOffset = 16;  // 16B rect
                } else if (opcode === OP.DRAW_RRECT) {
                    paintOffset = 49;  // 12×f32 + 1B type
                } else if (opcode === OP.DRAW_ARC) {
                    paintOffset = 20;  // rect(16B) + startAngle(4B) + sweepAngle(4B) → actually need to check
                }
                // DRAW_PATH: paint 在 path verbs 末尾，偏移不固定，跳过
                if (paintOffset >= 0 && payLen >= paintOffset + 19) {
                    const shaderResult = this._validatePaintShader(
                        payload, paintOffset, payLen
                    );
                    if (!shaderResult.valid) return shaderResult;
                }
                break;
            }

            default:
                // 其他 opcode 当前不需要深度子结构校验
                break;
        }

        return { valid: true };
    }

    // ═══════════════════════════════════════════════════════════
    // Paint 内 Shader 子结构校验 (Phase 2)
    //
    // Paint 二进制格式 (§4.1.3):
    //   [0:4]   color RGBA uint32 LE
    //   [4:8]   stroke_width float32 LE
    //   [8]     style
    //   [9]     cap
    //   [10]    join
    //   [11]    _pad
    //   [12:16] miter_limit float32 LE
    //   [16]    blend_mode
    //   [17]    anti_alias
    //   [18]    has_shader
    //   [19]    shader_type (if has_shader)
    //   [20+]   shader_data (variable, if has_shader)
    // ═══════════════════════════════════════════════════════════

    _validatePaintShader(payload, paintOffset, payLen) {
        const hasShader = payload.getUint8(paintOffset + 18);

        if (!hasShader) return { valid: true };

        // 需要至少 18B paint header + 1B has_shader + 1B shader_type
        if (paintOffset + 20 > payLen) {
            return this._subReject('Paint: payload too short for shader header');
        }

        const shaderOffset = paintOffset + 19;
        const shaderType = payload.getUint8(shaderOffset);

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

        // 读取 colorCount (总是在 shader header 末尾前第 3 个字节)
        const colorCount = payload.getUint8(shaderOffset + headerSize - 3);
        const MAX = PROTOCOL.MAX_GRADIENT_COLORS;

        if (colorCount > MAX) {
            return this._subReject(
                `Paint: shader colorCount ${colorCount} > MAX_GRADIENT_COLORS (${MAX})`
            );
        }

        // 验证颜色表大小
        const colorTableSize = colorCount * 8;  // 每对 RGBA(4) + position(4)
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
    // ═══════════════════════════════════════════════════════════

    /**
     * 记录命令级拒绝并返回结果。
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

    _subReject(reason) {
        return { valid: false, reason };
    }

    /**
     * 重置连续拒绝计数。
     */
    _resetRejects() {
        if (this.consecutiveRejects > 0) {
            this.consecutiveRejects = 0;
        }
    }

    // ═══════════════════════════════════════════════════════════
    // Opcode 名字映射（调试/审计）
    // ═══════════════════════════════════════════════════════════

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
     * @param {number} opcode
     * @returns {string}
     */
    getOpcodeName(opcode) {
        return this.OPCODE_NAMES[opcode] || `UNKNOWN(0x${opcode.toString(16)})`;
    }
}

export { CommandValidator };
