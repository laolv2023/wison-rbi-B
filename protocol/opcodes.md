# Wison-RBI Opcode Specification

> 版本: v1.6 | 与 `cpp/frame_constants.h` 和 `client/protocol.js` 严格一致

## Opcode 分配规则

| 范围 | 类别 | 说明 |
|------|------|------|
| `0x00` | 保留 | 空操作标记 |
| `0x01-0x0F` | 状态管理 | save, restore, saveLayer |
| `0x10-0x1F` | 变换 | translate, scale, rotate, concat, concat44 |
| `0x20-0x2F` | 裁剪 | clipRect, clipRRect, clipPath |
| `0x30-0x3F` | 形状绘制 | rect, rrect, oval, arc, path, points, region |
| `0x40-0x4F` | 图像绘制 | image, imageRect, lattice, atlas, patch, edgeAA |
| `0x50-0x5F` | 文本绘制 | textBlob, glyphRunList |
| `0x60-0x6F` | 其他绘制 | paint, color, shadow, vertices, drawable, annotation |
| `0x70-0x7F` | 扩展 | fontData, imageData, setMatrix, noop |
| `0x80-0xFF` | **非法** | 客户端必须拒收 |

## 完整 Opcode 列表

| Opcode | 名称 | Payload 格式 |
|--------|------|-------------|
| `0x01` | SAVE | 无 |
| `0x02` | RESTORE | 无 |
| `0x03` | SAVE_LAYER | bounds(16B) + paint(N) |
| `0x10` | CONCAT | matrix(9×f32=36B) |
| `0x11` | TRANSLATE | dx(f32) + dy(f32) = 8B |
| `0x12` | SCALE | sx(f32) + sy(f32) = 8B |
| `0x13` | ROTATE | radians(f32) = 4B |
| `0x14` | CONCAT44 | matrix(16×f32=64B) |
| `0x20` | CLIP_RECT | rect(16B) + op(u8) + doAA(u8) = 18B |
| `0x21` | CLIP_RRECT | rrect(49B) + op(u8) + doAA(u8) = 51B |
| `0x22` | CLIP_PATH | path(N) + op(u8) + doAA(u8) |
| `0x30` | DRAW_RECT | rect(16B) + paint(N) |
| `0x31` | DRAW_RRECT | rrect(49B) + paint(N) |
| `0x32` | DRAW_DRRECT | outer(49B) + inner(49B) + paint(N) |
| `0x33` | DRAW_OVAL | rect(16B) + paint(N) |
| `0x34` | DRAW_ARC | oval(16B) + start(f32) + sweep(f32) + useCenter(u8) + paint(N) |
| `0x35` | DRAW_PATH | verbCount(u32) + pointCount(u32) + verbs[] + points[] + paint(N) |
| `0x36` | DRAW_POINTS | mode(u8) + count(u32) + pts[count×8B] + paint(N) |
| `0x37` | DRAW_REGION | region(N) + paint(N) |
| `0x40` | DRAW_IMAGE | flag(u8) + [hash(32B) 或 slot(u32)+size(u32)+data(N)] + x(f32) + y(f32) |
| `0x41` | DRAW_IMAGE_RECT | flag(u8) + ... + src(16B) + dst(16B) |
| `0x42` | DRAW_IMAGE_LATTICE | image(N) + lattice(N) + dst(16B) + filter(u8) |
| `0x43` | DRAW_ATLAS | count(u32) + xforms[count×16B] + tex[count×16B] + colors[count×4B] + ... |
| `0x44` | DRAW_PATCH | cubics[12×f32=48B] + colors[4×4B=16B] + texCoords[4×f32=16B] + ... |
| `0x45` | DRAW_EDGE_AA_QUAD | rect(16B) + clip[4×f32=16B] + aaFlags(u8) + color(16B) + mode(u8) |
| `0x46` | DRAW_EDGE_AA_IMAGE_SET | count(u32) + entries[] + dstClips[] + ... |
| `0x50` | DRAW_TEXT_BLOB | x(f32) + y(f32) + glyphCount(u32) + glyphs[N×2B] + positions[N×8B] + paint(N) |
| `0x51` | DRAW_GLYPH_RUN_LIST | runs(N) + paint(N) |
| `0x60` | DRAW_PAINT | paint(N) |
| `0x61` | DRAW_COLOR | r(u8) + g(u8) + b(u8) + a(u8) + mode(u8) = 5B |
| `0x62` | DRAW_SHADOW | path(N) + shadowRec(N) |
| `0x63` | DRAW_VERTICES_OBJECT | mode(u8) + vertexCount(u32) + indexCount(u32) + positions[] + ... |
| `0x64` | DRAW_DRAWABLE | 跳过 (noop) — Drawable 不可序列化 |
| `0x65` | DRAW_ANNOTATION | rect(16B) + key(N) + value(N) |
| `0x70` | FONT_DATA | fontId(u32) + size(u32) + data[N] |
| `0x71` | IMAGE_DATA | slotId(u32) + size(u32) + data[N] |
| `0x72` | SET_MATRIX | matrix(9×f32=36B) |
| `0x7F` | NOOP | 无 |

## Payload 注意事项

- 所有多字节值 **Little Endian**
- `f32` 使用 IEEE 754 单精度浮点
- 命令流以 **4 字节对齐**（填充零字节）
- Path verbs 编码: 0=moveTo, 1=lineTo, 2=quadTo, 3=conicTo, 4=cubicTo, 5=close
- 图像 flag: 0x00=内联, 0x01=hash引用
