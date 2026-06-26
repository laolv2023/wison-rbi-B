// test_mocks.h — Minimal mock Skia types sufficient for compiling and testing
// the Wison-RBI C++ code WITHOUT Chromium.
//
// This file is self-contained. Include it instead of all Skia headers.
// All types are in the global namespace (matching real Skia).

#ifndef GARNET_TEST_MOCKS_H_
#define GARNET_TEST_MOCKS_H_

#include <cstdint>
#include <cstring>
#include <cstddef>
#include <utility>
#include <vector>

// ============================================================================
// Forward declarations for mutual references
// ============================================================================
class SkPaint;
class SkPath;
class SkImage;
class SkShader;
class SkPathEffect;
class SkFont;
class SkData;
class SkCanvas;

// ============================================================================
// SkScalar — float typedef
// ============================================================================
typedef float SkScalar;

// ============================================================================
// SkColor — uint32_t ARGB
// ============================================================================
typedef uint32_t SkColor;

static constexpr SkColor SK_ColorTRANSPARENT = 0x00000000;

inline uint8_t SkColorGetR(SkColor c) { return static_cast<uint8_t>((c >> 16) & 0xFF); }
inline uint8_t SkColorGetG(SkColor c) { return static_cast<uint8_t>((c >> 8) & 0xFF); }
inline uint8_t SkColorGetB(SkColor c) { return static_cast<uint8_t>(c & 0xFF); }
inline uint8_t SkColorGetA(SkColor c) { return static_cast<uint8_t>((c >> 24) & 0xFF); }

inline SkColor SkColorSetARGB(uint8_t a, uint8_t r, uint8_t g, uint8_t b) {
    return (uint32_t)a << 24 | (uint32_t)r << 16 | (uint32_t)g << 8 | (uint32_t)b;
}

// ============================================================================
// SkPoint — 2D point
// ============================================================================
struct SkPoint {
    SkScalar fX = 0.0f;
    SkScalar fY = 0.0f;

    SkPoint() = default;
    SkPoint(SkScalar x, SkScalar y) : fX(x), fY(y) {}

    SkScalar x() const { return fX; }
    SkScalar y() const { return fY; }
};

// SkVector is an alias for SkPoint (used by SkRRect::radii)
typedef SkPoint SkVector;

// ============================================================================
// SkRect — axis-aligned rectangle
// ============================================================================
struct SkRect {
    SkScalar fLeft   = 0.0f;
    SkScalar fTop    = 0.0f;
    SkScalar fRight  = 0.0f;
    SkScalar fBottom = 0.0f;

    SkRect() = default;
    SkRect(SkScalar l, SkScalar t, SkScalar r, SkScalar b)
        : fLeft(l), fTop(t), fRight(r), fBottom(b) {}

    SkScalar left()   const { return fLeft; }
    SkScalar top()    const { return fTop; }
    SkScalar right()  const { return fRight; }
    SkScalar bottom() const { return fBottom; }

    SkScalar width()  const { return fRight - fLeft; }
    SkScalar height() const { return fBottom - fTop; }

    bool isEmpty() const { return fLeft >= fRight || fTop >= fBottom; }

    static SkRect MakeXYWH(SkScalar x, SkScalar y, SkScalar w, SkScalar h) {
        return SkRect{x, y, x + w, y + h};
    }
};

// ============================================================================
// SkIRect — integer rectangle (used by SkCanvas::Lattice)
// ============================================================================
struct SkIRect {
    int32_t fLeft   = 0;
    int32_t fTop    = 0;
    int32_t fRight  = 0;
    int32_t fBottom = 0;

    SkIRect() = default;
    SkIRect(int32_t l, int32_t t, int32_t r, int32_t b)
        : fLeft(l), fTop(t), fRight(r), fBottom(b) {}
};

// ============================================================================
// SkRRect — rounded rectangle
// ============================================================================
class SkRRect {
public:
    enum Type : uint8_t {
        kEmpty_Type     = 0,
        kRect_Type      = 1,
        kOval_Type      = 2,
        kSimple_Type    = 3,
        kNinePatch_Type = 4,
        kComplex_Type   = 5,
    };

    enum Corner : uint8_t {
        kUpperLeft_Corner  = 0,
        kUpperRight_Corner = 1,
        kLowerRight_Corner = 2,
        kLowerLeft_Corner  = 3,
    };

    SkRRect() : type_(kEmpty_Type) {}

    Type type() const { return type_; }
    SkRect rect() const { return rect_; }
    SkVector radii(Corner corner) const {
        return radii_[(int)corner];
    }

    // Allow setting for test construction
    void setType(Type t) { type_ = t; }
    void setRect(const SkRect& r) { rect_ = r; }
    void setRadii(Corner c, const SkVector& v) { radii_[(int)c] = v; }

private:
    Type type_ = kEmpty_Type;
    SkRect rect_;
    SkVector radii_[4];
};

// ============================================================================
// SkColor4f — RGBA color with float components
// ============================================================================
struct SkColor4f {
    float fR = 0.0f;
    float fG = 0.0f;
    float fB = 0.0f;
    float fA = 0.0f;

    SkColor4f() = default;
    SkColor4f(float r, float g, float b, float a) : fR(r), fG(g), fB(b), fA(a) {}

    static SkColor4f FromColor(SkColor c) {
        return SkColor4f(
            SkColorGetR(c) / 255.0f,
            SkColorGetG(c) / 255.0f,
            SkColorGetB(c) / 255.0f,
            SkColorGetA(c) / 255.0f
        );
    }
};

// ============================================================================
// SkMatrix — 3×3 row-major matrix
// ============================================================================
class SkMatrix {
public:
    SkMatrix() {
        // Identity
        fMat[0] = 1.0f; fMat[1] = 0.0f; fMat[2] = 0.0f;
        fMat[3] = 0.0f; fMat[4] = 1.0f; fMat[5] = 0.0f;
        fMat[6] = 0.0f; fMat[7] = 0.0f; fMat[8] = 1.0f;
    }

    SkScalar operator[](int index) const { return fMat[index]; }
    SkScalar& operator[](int index) { return fMat[index]; }

    void get9(SkScalar buffer[9]) const {
        for (int i = 0; i < 9; ++i) buffer[i] = fMat[i];
    }

private:
    SkScalar fMat[9];
};

// ============================================================================
// SkM44 — 4×4 row-major matrix
// ============================================================================
struct SkM44 {
    float fMat[16] = {
        1,0,0,0,
        0,1,0,0,
        0,0,1,0,
        0,0,0,1
    };

    SkM44() = default;

    float rc(int r, int c) const { return fMat[r * 4 + c]; }
    void setRC(int r, int c, float v) { fMat[r * 4 + c] = v; }
};

// ============================================================================
// SkRefCnt — base class for ref-counted objects
// ============================================================================
class SkRefCnt {
public:
    SkRefCnt() : fRefCnt(1) {}
    virtual ~SkRefCnt() = default;

    void ref() const { ++fRefCnt; }
    void unref() const {
        if (--fRefCnt == 0) delete this;
    }

    int getRefCnt() const { return fRefCnt; }

private:
    mutable int fRefCnt;
};

// ============================================================================
// sk_sp<T> — ref-counted smart pointer
// ============================================================================
template <typename T>
class sk_sp {
public:
    sk_sp() : fPtr(nullptr) {}
    sk_sp(std::nullptr_t) : fPtr(nullptr) {}

    explicit sk_sp(T* ptr) : fPtr(ptr) {
        if (fPtr) fPtr->ref();
    }

    sk_sp(const sk_sp<T>& other) : fPtr(other.fPtr) {
        if (fPtr) fPtr->ref();
    }

    sk_sp(sk_sp<T>&& other) noexcept : fPtr(other.fPtr) {
        other.fPtr = nullptr;
    }

    template <typename U>
    sk_sp(const sk_sp<U>& other) : fPtr(static_cast<T*>(other.get())) {
        if (fPtr) fPtr->ref();
    }

    ~sk_sp() {
        if (fPtr) fPtr->unref();
    }

    sk_sp<T>& operator=(const sk_sp<T>& other) {
        if (this != &other) {
            sk_sp<T> tmp(other);
            swap(tmp);
        }
        return *this;
    }

    sk_sp<T>& operator=(sk_sp<T>&& other) noexcept {
        if (this != &other) {
            sk_sp<T> tmp(std::move(other));
            swap(tmp);
        }
        return *this;
    }

    sk_sp<T>& operator=(std::nullptr_t) {
        if (fPtr) fPtr->unref();
        fPtr = nullptr;
        return *this;
    }

    T* get() const { return fPtr; }
    T& operator*() const { return *fPtr; }
    T* operator->() const { return fPtr; }
    explicit operator bool() const { return fPtr != nullptr; }

    void swap(sk_sp<T>& other) {
        T* tmp = fPtr;
        fPtr = other.fPtr;
        other.fPtr = tmp;
    }

private:
    T* fPtr;
};

template <typename T, typename... Args>
sk_sp<T> sk_make_sp(Args&&... args) {
    return sk_sp<T>(new T(std::forward<Args>(args)...));
}

// ============================================================================
// SkData — immutable byte buffer
// ============================================================================
class SkData : public SkRefCnt {
public:
    const void* data() const { return data_.data(); }
    size_t size() const { return data_.size(); }

    static sk_sp<SkData> MakeWithCopy(const void* ptr, size_t len) {
        if (!ptr || len == 0) {
            auto* d = new SkData();
            return sk_sp<SkData>(d);
        }
        auto* d = new SkData();
        const uint8_t* src = static_cast<const uint8_t*>(ptr);
        d->data_.assign(src, src + len);
        return sk_sp<SkData>(d);
    }

private:
    std::vector<uint8_t> data_;
};

// ============================================================================
// SkImageInfo — image description
// ============================================================================
enum SkColorType : int {
    kUnknown_SkColorType = 0,
    kRGBA_8888_SkColorType = 1,
    kBGRA_8888_SkColorType = 2,
    kN32_SkColorType = kRGBA_8888_SkColorType,
};

enum SkAlphaType : int {
    kUnknown_SkAlphaType = 0,
    kOpaque_SkAlphaType  = 1,
    kPremul_SkAlphaType  = 2,
    kUnpremul_SkAlphaType = 3,
};

struct SkImageInfo {
    int         fWidth       = 0;
    int         fHeight      = 0;
    SkColorType fColorType   = kUnknown_SkColorType;
    SkAlphaType fAlphaType   = kUnknown_SkAlphaType;

    static SkImageInfo Make(int w, int h, SkColorType ct, SkAlphaType at) {
        SkImageInfo info;
        info.fWidth     = w;
        info.fHeight    = h;
        info.fColorType = ct;
        info.fAlphaType = at;
        return info;
    }
};

// ============================================================================
// SkPixmap — pixel map (CPU-accessible pixels)
// ============================================================================
class SkPixmap {
public:
    SkPixmap() = default;

    void* addr() { return pixels_.data(); }
    const void* addr() const { return pixels_.data(); }
    size_t computeByteSize() const { return pixels_.size(); }
    int width() const { return info_.fWidth; }
    int height() const { return info_.fHeight; }

    // For testing: allocate backing store
    void reset(const SkImageInfo& info, const void* data, size_t rowBytes) {
        info_ = info;
        size_t total = info.fHeight * rowBytes;
        const uint8_t* src = static_cast<const uint8_t*>(data);
        pixels_.assign(src, src + total);
    }

private:
    SkImageInfo info_;
    std::vector<uint8_t> pixels_;
};

// ============================================================================
// SkBitmap — raster bitmap
// ============================================================================
class SkBitmap {
public:
    SkBitmap() = default;

    void allocPixels(const SkImageInfo& info) {
        info_ = info;
        size_t rowBytes = info.fWidth * 4;
        pixels_.resize(info.fHeight * rowBytes, 0);
    }

    void eraseColor(SkColor color) {
        uint8_t a = SkColorGetA(color);
        uint8_t r = SkColorGetR(color);
        uint8_t g = SkColorGetG(color);
        uint8_t b = SkColorGetB(color);
        for (size_t i = 0; i + 3 < pixels_.size(); i += 4) {
            pixels_[i + 0] = b;
            pixels_[i + 1] = g;
            pixels_[i + 2] = r;
            pixels_[i + 3] = a;
        }
    }

    int width()  const { return info_.fWidth; }
    int height() const { return info_.fHeight; }

private:
    SkImageInfo info_;
    std::vector<uint8_t> pixels_;
};

// ============================================================================
// SkFont — font descriptor
// ============================================================================
class SkFont : public SkRefCnt {
public:
    uint32_t uniqueID() const { return unique_id_; }
    void setUniqueID(uint32_t id) { unique_id_ = id; }

private:
    uint32_t unique_id_ = 0;
};

// ============================================================================
// SkPath — geometric path
// ============================================================================
class SkPath {
public:
    enum Verb : uint8_t {
        kMove_Verb  = 0,
        kLine_Verb  = 1,
        kQuad_Verb  = 2,
        kConic_Verb = 3,
        kCubic_Verb = 4,
        kClose_Verb = 5,
    };

    int countVerbs() const { return static_cast<int>(verbs_.size()); }
    int countPoints() const { return static_cast<int>(points_.size()); }

    int getVerbs(uint8_t* dst, int max) const {
        int n = std::min(max, (int)verbs_.size());
        for (int i = 0; i < n; ++i) dst[i] = verbs_[i];
        return n;
    }

    int getPoints(SkPoint* dst, int max) const {
        int n = std::min(max, (int)points_.size());
        for (int i = 0; i < n; ++i) dst[i] = points_[i];
        return n;
    }

    // For testing
    void moveTo(SkScalar x, SkScalar y) {
        verbs_.push_back(kMove_Verb);
        points_.push_back(SkPoint(x, y));
    }
    void lineTo(SkScalar x, SkScalar y) {
        verbs_.push_back(kLine_Verb);
        points_.push_back(SkPoint(x, y));
    }
    void close() {
        verbs_.push_back(kClose_Verb);
    }

private:
    std::vector<uint8_t> verbs_;
    std::vector<SkPoint> points_;
};

// ============================================================================
// SkTextBlob — run of positioned glyphs
// ============================================================================
class SkTextBlob : public SkRefCnt {
public:
    class Iter {
    public:
        struct Run {
            const SkFont*    fFont    = nullptr;
            int              fGlyphCount = 0;
            const uint16_t*  fGlyphIndices = nullptr;
            const SkPoint*   fPos = nullptr;
        };

        Iter(const SkTextBlob& blob) : blob_(blob), index_(0) {}

        bool next(Run* run) {
            if (index_ >= blob_.runs_.size()) return false;
            *run = blob_.runs_[index_];
            ++index_;
            return true;
        }

    private:
        const SkTextBlob& blob_;
        size_t index_;
    };

    // For testing: add a run
    void addRun(const Iter::Run& run) { runs_.push_back(run); }

private:
    std::vector<Iter::Run> runs_;
};

// ============================================================================
// SkEncodedImageFormat — image encoding format
// ============================================================================
enum SkEncodedImageFormat : int {
    kPNG  = 0,
    kJPEG = 1,
    kWebP = 2,
};

// ============================================================================
// SkImage — abstract image
// ============================================================================
class SkImage : public SkRefCnt {
public:
    sk_sp<SkData> encodeToData(SkEncodedImageFormat /*format*/, int /*quality*/) const {
        // Minimal stub: return empty data
        return sk_sp<SkData>(new SkData());
    }

    bool peekPixels(SkPixmap* pixmap) const {
        // Stub: images are not raster-backed
        (void)pixmap;
        return false;
    }

    int width()  const { return width_; }
    int height() const { return height_; }

    void setWidth(int w)  { width_ = w; }
    void setHeight(int h) { height_ = h; }

private:
    int width_  = 0;
    int height_ = 0;
};

// ============================================================================
// SkBlendMode — blending mode
// ============================================================================
enum class SkBlendMode : uint8_t {
    kClear    = 0,
    kSrc      = 1,
    kDst      = 2,
    kSrcOver  = 3,
    kDstOver  = 4,
    kSrcIn    = 5,
    kDstIn    = 6,
    kSrcOut   = 7,
    kDstOut   = 8,
    kSrcATop  = 9,
    kDstATop  = 10,
    kXor      = 11,
    kPlus     = 12,
    kModulate = 13,
    kScreen   = 14,
    kOverlay  = 15,
    kDarken   = 16,
    kLighten  = 17,
    kColorDodge  = 18,
    kColorBurn   = 19,
    kHardLight   = 20,
    kSoftLight   = 21,
    kDifference  = 22,
    kExclusion   = 23,
    kMultiply    = 24,
    kHue         = 25,
    kSaturation  = 26,
    kColor       = 27,
    kLuminosity  = 28,
};

// ============================================================================
// SkClipOp — clip operation
// ============================================================================
enum class SkClipOp : uint8_t {
    kDifference = 0,
    kIntersect  = 1,
};

// ============================================================================
// SkFilterMode — sampling filter mode
// ============================================================================
enum class SkFilterMode : uint8_t {
    kNearest = 0,
    kLinear  = 1,
};

// ============================================================================
// SkMipmapMode — mipmap mode
// ============================================================================
enum class SkMipmapMode : uint8_t {
    kNone    = 0,
    kNearest = 1,
    kLinear  = 2,
};

// ============================================================================
// SkSamplingOptions — image sampling options
// ============================================================================
class SkSamplingOptions {
public:
    struct Cubic {
        float B = 1.0f / 3.0f;
        float C = 1.0f / 3.0f;
    };

    bool         useCubic = false;
    Cubic        cubic;
    SkFilterMode filter   = SkFilterMode::kNearest;
    SkMipmapMode mipmap   = SkMipmapMode::kNone;

    SkSamplingOptions() = default;
    SkSamplingOptions(SkFilterMode f) : filter(f) {}
    SkSamplingOptions(const Cubic& c) : useCubic(true), cubic(c) {}

    bool isAniso() const { return false; }  // No anisotropy in mocks
};

// ============================================================================
// SkShader::GradientInfo — gradient extraction
// ============================================================================
class SkShader : public SkRefCnt {
public:
    enum GradientType : uint8_t {
        kNone_GradientType    = 0,
        kLinear_GradientType  = 1,
        kRadial_GradientType  = 2,
        kSweep_GradientType   = 3,
        kConical_GradientType = 4,
    };

    enum TileMode : uint8_t {
        kClamp_TileMode  = 0,
        kRepeat_TileMode = 1,
        kMirror_TileMode = 2,
        kDecal_TileMode  = 3,
    };

    struct GradientInfo {
        SkPoint     fPoint[2];       // start, end
        SkScalar*   fColorOffsets = nullptr;
        SkColor*    fColors       = nullptr;
        int         fColorCount   = 0;
        TileMode    fTileMode     = kClamp_TileMode;
    };

    virtual int asAGradient(GradientInfo* info) const {
        (void)info;
        return 0;  // Not a gradient by default
    }
};

// ============================================================================
// SkPathEffect::DashInfo — dash effect extraction
// ============================================================================
class SkPathEffect : public SkRefCnt {
public:
    enum DashType : uint8_t {
        kDash = 0,
    };

    struct DashInfo {
        SkScalar*  fIntervals = nullptr;
        int32_t    fCount     = 0;
        SkScalar   fPhase     = 0.0f;
    };

    virtual DashType asADash(DashInfo* info) const {
        if (info) info->fCount = 0;
        return kDash;
    }
};

// ============================================================================
// SkPaint — drawing attributes
// ============================================================================
class SkPaint {
public:
    enum Style : uint8_t {
        kFill_Style            = 0,
        kStroke_Style          = 1,
        kStrokeAndFill_Style   = 2,
    };

    enum Cap : uint8_t {
        kButt_Cap   = 0,
        kRound_Cap  = 1,
        kSquare_Cap = 2,
    };

    enum Join : uint8_t {
        kMiter_Join = 0,
        kRound_Join = 1,
        kBevel_Join = 2,
    };

    SkPaint() = default;

    // Getters
    SkColor4f   getColor4f()                    const { return color_; }
    SkBlendMode getBlendMode_or(SkBlendMode d)  const { return blend_mode_; }
    Style       getStyle()                      const { return style_; }
    SkScalar    getStrokeWidth()                const { return stroke_width_; }
    SkScalar    getStrokeMiter()                const { return stroke_miter_; }
    Cap         getStrokeCap()                  const { return stroke_cap_; }
    Join        getStrokeJoin()                 const { return stroke_join_; }
    bool        isAntiAlias()                   const { return antialias_; }
    float       getAlphaf()                     const { return color_.fA; }
    SkColor     getColor()                      const {
        uint8_t a = (uint8_t)(color_.fA * 255);
        uint8_t r = (uint8_t)(color_.fR * 255);
        uint8_t g = (uint8_t)(color_.fG * 255);
        uint8_t b = (uint8_t)(color_.fB * 255);
        return (uint32_t)a << 24 | (uint32_t)r << 16 | (uint32_t)g << 8 | (uint32_t)b;
    }

    // Setters (for testing)
    void setColor4f(const SkColor4f& c)       { color_ = c; }
    void setColor(SkColor c) {
        color_.fA = SkColorGetA(c) / 255.0f;
        color_.fR = SkColorGetR(c) / 255.0f;
        color_.fG = SkColorGetG(c) / 255.0f;
        color_.fB = SkColorGetB(c) / 255.0f;
    }
    void setAlphaf(float a)                   { color_.fA = a; }
    void setBlendMode(SkBlendMode m)          { blend_mode_ = m; }
    void setStyle(Style s)                    { style_ = s; }
    void setStrokeWidth(SkScalar w)           { stroke_width_ = w; }
    void setStrokeMiter(SkScalar m)           { stroke_miter_ = m; }
    void setStrokeCap(Cap c)                  { stroke_cap_ = c; }
    void setStrokeJoin(Join j)                { stroke_join_ = j; }
    void setAntiAlias(bool aa)                { antialias_ = aa; }

    // Shader / PathEffect
    sk_sp<SkShader> refShader() const         { return shader_; }
    void setShader(sk_sp<SkShader> s)         { shader_ = std::move(s); }

    sk_sp<SkPathEffect> refPathEffect() const { return path_effect_; }
    void setPathEffect(sk_sp<SkPathEffect> pe){ path_effect_ = std::move(pe); }

private:
    SkColor4f    color_        = SkColor4f{0,0,0,1};
    SkBlendMode  blend_mode_   = SkBlendMode::kSrcOver;
    Style        style_        = kFill_Style;
    SkScalar     stroke_width_ = 0.0f;
    SkScalar     stroke_miter_ = 4.0f;
    Cap          stroke_cap_   = kButt_Cap;
    Join         stroke_join_  = kMiter_Join;
    bool         antialias_    = true;
    sk_sp<SkShader>     shader_;
    sk_sp<SkPathEffect> path_effect_;
};

// ============================================================================
// SkPoint3 — 3D point (used by SkDrawShadowRec)
// ============================================================================
struct SkPoint3 {
    SkScalar fX = 0.0f;
    SkScalar fY = 0.0f;
    SkScalar fZ = 0.0f;

    SkPoint3() = default;
    SkPoint3(SkScalar x, SkScalar y, SkScalar z) : fX(x), fY(y), fZ(z) {}
};

// ============================================================================
// SkRSXform — rotated-scale-translate transform
// ============================================================================
struct SkRSXform {
    SkScalar fSCos = 1.0f;
    SkScalar fSSin = 0.0f;
    SkScalar fTx   = 0.0f;
    SkScalar fTy   = 0.0f;
};

// ============================================================================
// SkDrawShadowRec — shadow record
// ============================================================================
struct SkDrawShadowRec {
    SkPoint3 fZPlaneParams;        // 3D: x, y, z
    SkPoint3 fLightPos;            // 3D: x, y, z
    SkScalar fLightRadius  = 0.0f;
    SkColor  fAmbientColor = 0;
    SkColor  fSpotColor    = 0;
    uint32_t fFlags        = 0;
};

// ============================================================================
// SkVertices — vertex data
// ============================================================================
class SkVertices : public SkRefCnt {
public:
    enum VertexMode : uint8_t {
        kTriangles_VertexMode     = 0,
        kTriangleStrip_VertexMode = 1,
        kTriangleFan_VertexMode   = 2,
    };

    VertexMode mode() const { return mode_; }

    int vertexCount() const { return (int)positions_.size(); }
    int indexCount()  const { return (int)indices_.size(); }
    bool hasTexCoords() const { return !tex_coords_.empty(); }
    bool hasColors()    const { return !colors_.empty(); }

    const SkPoint*   positions()  const { return positions_.data(); }
    const SkPoint*   texCoords()  const { return tex_coords_.data(); }
    const SkColor*   colors()     const { return colors_.data(); }
    const uint16_t*  indices()    const { return indices_.data(); }

    // For testing
    void setMode(VertexMode m) { mode_ = m; }
    void setPositions(const std::vector<SkPoint>& p) { positions_ = p; }
    void setTexCoords(const std::vector<SkPoint>& t) { tex_coords_ = t; }
    void setColors(const std::vector<SkColor>& c)    { colors_ = c; }
    void setIndices(const std::vector<uint16_t>& i)  { indices_ = i; }

private:
    VertexMode mode_ = kTriangles_VertexMode;
    std::vector<SkPoint>  positions_;
    std::vector<SkPoint>  tex_coords_;
    std::vector<SkColor>  colors_;
    std::vector<uint16_t> indices_;
};

// ============================================================================
// SkGlyphRun — single glyph run (used in SkGlyphRunList)
// ============================================================================
struct SkGlyphRun {
    const SkFont*    fFont      = nullptr;
    size_t           fGlyphCount = 0;
    const uint16_t*  fGlyphs    = nullptr;
    const SkPoint*   fPositions = nullptr;
};

// ============================================================================
// SkGlyphRunList — list of glyph runs
// ============================================================================
class SkGlyphRunList {
public:
    using const_iterator = std::vector<SkGlyphRun>::const_iterator;

    size_t size() const { return runs_.size(); }

    const_iterator begin() const { return runs_.begin(); }
    const_iterator end()   const { return runs_.end(); }

    // For testing
    void addRun(const SkGlyphRun& run) { runs_.push_back(run); }

private:
    std::vector<SkGlyphRun> runs_;
};

// ============================================================================
// SkDrawable — drawable object (not serializable, NOOP)
// ============================================================================
class SkDrawable : public SkRefCnt {
public:
    SkDrawable() = default;
};

// ============================================================================
// SkRegion — clipping region (minimal stub)
// ============================================================================
class SkRegion {
public:
    SkRegion() = default;
    bool isEmpty() const { return true; }
};

// ============================================================================
// SkCanvas — base canvas with virtual draw methods
// ============================================================================
class SkCanvas {
public:
    enum PointMode : uint8_t {
        kPoints_PointMode  = 0,
        kLines_PointMode   = 1,
        kPolygon_PointMode = 2,
    };

    enum QuadAAFlags : uint32_t {
        kNone_QuadAAFlags     = 0,
        kTop_QuadAAFlag       = 1 << 0,
        kBottom_QuadAAFlag    = 1 << 1,
        kLeft_QuadAAFlag      = 1 << 2,
        kRight_QuadAAFlag     = 1 << 3,
        kAll_QuadAAFlags      = kTop_QuadAAFlag | kBottom_QuadAAFlag
                               | kLeft_QuadAAFlag | kRight_QuadAAFlag,
    };

    enum SrcRectConstraint : uint8_t {
        kStrict_SrcRectConstraint = 0,
        kFast_SrcRectConstraint   = 1,
    };

    struct Lattice {
        const int*     fXDivs   = nullptr;
        const int*     fYDivs   = nullptr;
        const SkIRect* fBounds  = nullptr;
        int            fXCount  = 0;
        int            fYCount  = 0;
    };

    struct ImageSetEntry {
        sk_sp<SkImage> fImage;
        SkRect         fSrcRect;
        SkRect         fDstRect;
        float          fAlpha   = 1.0f;
        uint32_t       fAAFlags = 0;
    };

    explicit SkCanvas(const SkBitmap& /*device*/) {}
    virtual ~SkCanvas() = default;

    // State management
    virtual int  save() { return save_count_++; }
    virtual void restore() { --save_count_; }
    virtual int  saveLayer(const SkRect* /*bounds*/, const SkPaint* /*paint*/) {
        return save_count_++;
    }

    // Pixel reads — return false by default
    virtual bool onReadPixels(const SkPixmap& /*dst*/, int /*x*/, int /*y*/) {
        return false;
    }

    // Transform
    virtual void concat(const SkMatrix& /*matrix*/) {}
    virtual void translate(SkScalar /*dx*/, SkScalar /*dy*/) {}
    virtual void scale(SkScalar /*sx*/, SkScalar /*sy*/) {}
    virtual void rotate(SkScalar /*radians*/) {}
    virtual void concat44(const SkM44& /*matrix*/) {}

    // Clip
    virtual void clipRect(const SkRect& /*rect*/, SkClipOp /*op*/, bool /*doAA*/) {}
    virtual void clipRRect(const SkRRect& /*rrect*/, SkClipOp /*op*/, bool /*doAA*/) {}
    virtual void clipPath(const SkPath& /*path*/, SkClipOp /*op*/, bool /*doAA*/) {}

    // Draw shapes
    virtual void drawRect(const SkRect& /*rect*/, const SkPaint& /*paint*/) {}
    virtual void drawRRect(const SkRRect& /*rrect*/, const SkPaint& /*paint*/) {}
    virtual void drawDRRect(const SkRRect& /*outer*/, const SkRRect& /*inner*/,
                           const SkPaint& /*paint*/) {}
    virtual void drawOval(const SkRect& /*oval*/, const SkPaint& /*paint*/) {}
    virtual void drawArc(const SkRect& /*oval*/, SkScalar /*startAngle*/,
                        SkScalar /*sweepAngle*/, bool /*useCenter*/,
                        const SkPaint& /*paint*/) {}
    virtual void drawPath(const SkPath& /*path*/, const SkPaint& /*paint*/) {}
    virtual void drawPoints(PointMode /*mode*/, size_t /*count*/,
                           const SkPoint /*pts*/[], const SkPaint& /*paint*/) {}

    // Draw images
    virtual void drawImage(const SkImage* /*image*/, SkScalar /*left*/, SkScalar /*top*/,
                          const SkSamplingOptions& /*sampling*/ = {},
                          const SkPaint* /*paint*/ = nullptr) {}
    virtual void drawImageRect(const SkImage* /*image*/, const SkRect& /*src*/,
                              const SkRect& /*dst*/,
                              const SkSamplingOptions& /*sampling*/ = {},
                              const SkPaint* /*paint*/ = nullptr,
                              SrcRectConstraint /*constraint*/ = kStrict_SrcRectConstraint) {}
    virtual void drawImageLattice(const SkImage* /*image*/,
                                 const Lattice& /*lattice*/,
                                 const SkRect& /*dst*/, SkFilterMode /*filter*/,
                                 const SkPaint* /*paint*/ = nullptr) {}
    virtual void drawAtlas(const SkImage* /*atlas*/, const SkRSXform /*xform*/[],
                          const SkRect /*tex*/[], const SkColor /*colors*/[],
                          int /*count*/, SkBlendMode /*mode*/,
                          const SkSamplingOptions& /*sampling*/ = {},
                          const SkRect* /*cullRect*/ = nullptr,
                          const SkPaint* /*paint*/ = nullptr) {}
    virtual void drawPatch(const SkPoint /*cubics*/[12], const SkColor /*colors*/[4],
                          const SkPoint /*texCoords*/[4], SkBlendMode /*mode*/,
                          const SkPaint& /*paint*/) {}
    virtual void drawEdgeAAQuad(const SkRect& /*rect*/, const SkPoint /*clip*/[4],
                               QuadAAFlags /*aaFlags*/, const SkColor4f& /*color*/,
                               SkBlendMode /*mode*/) {}
    virtual void drawEdgeAAImageSet(const ImageSetEntry /*set*/[], int /*count*/,
                                   const SkPoint /*dstClips*/[],
                                   const SkMatrix /*preViewMatrices*/[],
                                   const SkSamplingOptions& /*sampling*/,
                                   const SkPaint* /*paint*/,
                                   SrcRectConstraint /*constraint*/) {}

    // Text
    virtual void drawTextBlob(const SkTextBlob* /*blob*/, SkScalar /*x*/, SkScalar /*y*/,
                             const SkPaint& /*paint*/) {}
    virtual void drawGlyphRunList(const SkGlyphRunList& /*glyphRunList*/,
                                 const SkPaint& /*paint*/) {}

    // Other draws
    virtual void drawPaint(const SkPaint& /*paint*/) {}
    virtual void drawColor(SkColor4f /*color*/, SkBlendMode /*mode*/ = SkBlendMode::kSrcOver) {}
    virtual void drawShadow(const SkPath& /*path*/, const SkDrawShadowRec& /*rec*/) {}
    virtual void drawVertices(const SkVertices* /*vertices*/, SkBlendMode /*mode*/,
                             const SkPaint& /*paint*/) {}
    virtual void drawDrawable(SkDrawable* /*drawable*/, const SkMatrix* /*matrix*/ = nullptr) {}
    virtual void drawAnnotation(const SkRect& /*rect*/, const char* /*key*/, SkData* /*value*/) {}

private:
    int save_count_ = 1;
};

// ============================================================================
// DisplayItemList — Chromium PaintOp container (mock)
// ============================================================================
class PaintOpBuffer {
public:
    const uint8_t* Data() const { return data_.data(); }
    size_t size() const { return data_.size(); }

    void setData(const std::vector<uint8_t>& d) { data_ = d; }

private:
    std::vector<uint8_t> data_;
};

class DisplayItemList {
public:
    SkRect VisualRect() const { return visual_rect_; }
    const PaintOpBuffer* paint_op_buffer() const { return &buffer_; }

    void setVisualRect(const SkRect& r) { visual_rect_ = r; }
    PaintOpBuffer* mutable_buffer() { return &buffer_; }

private:
    SkRect visual_rect_;
    PaintOpBuffer buffer_;
};

// ============================================================================
// SkSurfaceProps — surface properties (minimal stub)
// ============================================================================
struct SkSurfaceProps {
    uint32_t fFlags = 0;
    SkSurfaceProps() = default;
};

#endif // GARNET_TEST_MOCKS_H_
