// WebGL2 renderer for the live mirror. Three passes a frame:
//   1. background plate: a slowly built picture of the room, from pixels the segmenter calls
//      background; used to fill in where loose old clothes stuck out past the body;
//   2. garment: the skinned garment mesh into its own layer (colour + how much each pixel is torso);
//   3. composite to the canvas: the camera frame with the person's own clothes taken off (skin on
//      the body and limbs, background outside them) wherever the new garment doesn't cover, then
//      the garment with the camera's light and fold shading, and hands kept in front of the body.
// All coordinates are camera-crop pixels, unmirrored; the composite mirrors at the end.
import type { Pt } from "../lib/mirror/math";

const FULLSCREEN_VS = `#version 300 es
in vec2 aPos;
out vec2 vUv;
void main() { vUv = vec2(aPos.x * 0.5 + 0.5, 0.5 - aPos.y * 0.5); gl_Position = vec4(aPos, 0.0, 1.0); }`;

const PLATE_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
uniform sampler2D uVideo, uMask, uPrev;
uniform vec4 uCrop;
uniform bool uInit, uHasMask;
uniform vec2 uMaskShift; // the body's move since the mask's camera frame (video uv)
uniform vec3 uFill;
out vec4 o;
void main() {
  vec2 vuv = uCrop.xy + vUv * uCrop.zw;
  vec3 cam = texture(uVideo, vuv).rgb;
  float cat = uHasMask ? floor(texture(uMask, vuv - uMaskShift).r * 255.0 + 0.5) : 9.0;
  vec3 prev = uInit ? uFill : texture(uPrev, vec2(vUv.x, 1.0 - vUv.y)).rgb;
  // Only where this pixel and its neighbours are all background: the mask lags a moving person by
  // a frame, and taking their edges into the plate leaves smears.
  vec2 d = vec2(0.02, 0.015) * uCrop.zw;
  bool bg = cat < 0.5;
  for (int i = 0; i < 4 && bg; i++) {
    vec2 off = i == 0 ? vec2(d.x, 0.0) : i == 1 ? vec2(-d.x, 0.0) : i == 2 ? vec2(0.0, d.y) : vec2(0.0, -d.y);
    bg = floor(texture(uMask, vuv - uMaskShift + off).r * 255.0 + 0.5) < 0.5;
  }
  o = vec4(bg ? mix(prev, cam, 0.12) : prev, 1.0);
}`;

const MESH_VS = `#version 300 es
in vec2 aPos;
in vec2 aUv;
in float aTorso;
uniform vec2 uSize;
out vec2 vUv;
out float vTorso;
void main() {
  vUv = aUv;
  vTorso = aTorso;
  gl_Position = vec4(aPos.x / uSize.x * 2.0 - 1.0, 1.0 - aPos.y / uSize.y * 2.0, 0.0, 1.0);
}`;

const MESH_FS = `#version 300 es
precision mediump float;
in vec2 vUv;
in float vTorso;
uniform sampler2D uGarment;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oAux;
void main() {
  vec4 c = texture(uGarment, vUv);
  oColor = vec4(c.rgb * c.a, c.a);
  oAux = vec4(vTorso * c.a, 0.0, 0.0, c.a);
}`;

const COMPOSITE_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uVideo, uMask, uPlate, uLayer, uAux;
uniform vec4 uCrop;
uniform vec2 uSize;
uniform bool uMirror, uTakeOff, uGarmentOn, uHasMask, uHasTorso;
uniform vec2 uMaskShift;
uniform vec4 uLimb[12];
uniform float uLimbR[12];
uniform int uLimbN;
uniform vec4 uArm[2];
uniform float uArmR[2];
uniform int uArmN;
uniform vec2 uTorso[4];
uniform vec3 uSkin;
uniform float uSceneLum;
uniform vec2 uCenter;
uniform bool uDebug;
uniform vec3 uOld;
uniform bool uHasOld;
out vec4 o;

float lum(vec3 c) { return dot(c, vec3(0.299, 0.587, 0.114)); }
float segDist(vec2 p, vec2 a, vec2 b) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / max(dot(ba, ba), 1e-4), 0.0, 1.0);
  return length(pa - ba * h);
}
bool inTorso(vec2 p) {
  if (!uHasTorso) return false;
  float s = 0.0;
  for (int i = 0; i < 4; i++) {
    vec2 a = uTorso[i], b = uTorso[(i + 1) % 4];
    float c = (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
    if (s == 0.0) s = sign(c);
    else if (sign(c) != s && c != 0.0) return false;
  }
  return true;
}
bool inLimb(vec2 p) {
  for (int i = 0; i < 12; i++) { if (i >= uLimbN) break; if (segDist(p, uLimb[i].xy, uLimb[i].zw) < uLimbR[i]) return true; }
  return false;
}
bool inArm(vec2 p) {
  for (int i = 0; i < 2; i++) { if (i >= uArmN) break; if (segDist(p, uArm[i].xy, uArm[i].zw) < uArmR[i]) return true; }
  return false;
}
// The mask is a few frames old: look where this pixel's body was when the mask was made.
float catAt(vec2 vuv) { return floor(texture(uMask, vuv - uMaskShift).r * 255.0 + 0.5); }
// Old clothes here or within a few pixels: the segmenter's mask is coarse, and an undilated test
// leaves a thin fringe of the old shirt around the new garment.
bool oldClothes(vec2 vuv) {
  vec2 d = 8.0 / (uSize / uCrop.zw);
  if (catAt(vuv) == 4.0) return true;
  for (int i = 0; i < 8; i++) {
    float a = float(i) * 0.785398;
    if (catAt(vuv + vec2(cos(a), sin(a)) * d) == 4.0) return true;
  }
  return false;
}
// Old clothes sticking out a little past the new garment: carry the garment's edge over them by
// looking towards the middle of the body for the nearest garment pixel. Small mismatches in width or
// length then read as the new garment; bigger gaps are taken off as skin.
vec4 garmentEdge(vec2 uv) {
  vec2 c = uCenter / uSize;
  vec2 dir = c - uv;
  float len = length(dir * uSize);
  if (len < 1.0) return vec4(0.0);
  dir = dir / length(dir);
  float stepUv = 0.006;
  for (int i = 1; i <= 18; i++) {
    vec2 q = uv + dir * float(i) * stepUv;
    vec4 gq = texture(uLayer, vec2(q.x, 1.0 - q.y));
    if (gq.a > 0.7) {
      // Mirror the fabric across its edge instead of smearing the edge pixel (which streaks).
      vec2 r = uv + dir * float(2 * i) * stepUv;
      vec4 gr = texture(uLayer, vec2(r.x, 1.0 - r.y));
      return gr.a > 0.7 ? gr : gq;
    }
  }
  return vec4(0.0);
}
void main() {
  vec2 uv = vec2(uMirror ? 1.0 - vUv.x : vUv.x, vUv.y);
  vec2 vuv = uCrop.xy + uv * uCrop.zw;
  vec2 fuv = vec2(uv.x, 1.0 - uv.y);
  vec3 cam = texture(uVideo, vuv).rgb;
  vec3 blur = textureLod(uVideo, vuv, 4.5).rgb;
  float cat = uHasMask ? catAt(vuv) : 0.0;
  vec2 p = uv * uSize;
  vec4 g = uGarmentOn ? texture(uLayer, fuv) : vec4(0.0);
  float torsoW = uGarmentOn ? texture(uAux, fuv).r : 0.0;
  float l = lum(cam);
  float lb = max(lum(blur), 0.03);
  vec3 color = cam;
  // Take the old clothes off where the new garment doesn't cover them: skin on the body parts this
  // garment replaces (uTorso and uLimb hold only those), the room behind loose fabric beside them.
  bool body = inTorso(p) || inLimb(p);
  // Only the clothes this garment replaces: jeans and a shirt are both "clothes" to the segmenter,
  // so the colour of the old garment (sampled mid-chest, or mid-thigh for bottoms) tells them apart.
  bool replaced = !uHasOld || distance(cam, uOld) < 0.3 || distance(blur, uOld) < 0.22;
  if (uTakeOff && uGarmentOn && uHasMask && g.a < 0.6 && body && replaced && oldClothes(vuv)) {
    vec4 edge = garmentEdge(uv);
    if (edge.a > 0.0) {
      g = vec4(edge.rgb, edge.a) * (1.0 - g.a) + g; // the garment's edge carried over the old fabric
    } else {
      // Smooth skin from the coarse light only: fine texture of the old fabric would show through.
      vec3 coarse = textureLod(uVideo, vuv, 6.5).rgb;
      color = uSkin * clamp(lum(coarse) / uSceneLum, 0.75, 1.15);
    }
  } else if (uTakeOff && uGarmentOn && cat == 4.0 && g.a < 0.6 && uHasTorso && !body && replaced) {
    float dt = 1e9;
    for (int i = 0; i < 4; i++) dt = min(dt, segDist(p, uTorso[i], uTorso[(i + 1) % 4]));
    if (dt < uSize.x * 0.06) color = texture(uPlate, fuv).rgb;
  }
  if (g.a > 0.002) {
    vec3 gc = g.rgb / g.a;
    // Only the camera's local folds go on the new fabric (luminance against its blurred
    // surroundings). Absolute brightness would carry over the colour of the clothes underneath.
    float fold = clamp(l / lb, 0.85, 1.15);
    gc *= mix(1.0, fold, 0.8);
    float a = g.a;
    // A hand or forearm in front of the body stays in front of the garment.
    if (cat == 2.0 && torsoW > 0.3 * g.a && inArm(p)) a = 0.0;
    color = mix(color, gc, a);
  }
  if (uDebug) {
    vec3 cats[6] = vec3[6](vec3(0.1), vec3(0.6, 0.3, 0.1), vec3(1.0, 0.75, 0.6), vec3(1.0, 0.5, 0.4), vec3(0.2, 0.4, 1.0), vec3(0.2, 0.9, 0.3));
    color = mix(cam, cats[int(clamp(cat, 0.0, 5.0))], 0.65);
    if (inTorso(p)) color = mix(color, vec3(1.0, 0.0, 1.0), 0.25);
    if (inLimb(p)) color = mix(color, vec3(1.0, 1.0, 0.0), 0.25);
  }
  o = vec4(color, 1.0);
}`;

function compile(gl: WebGL2RenderingContext, vs: string, fs: string): WebGLProgram {
  const program = gl.createProgram()!;
  for (const [type, src] of [
    [gl.VERTEX_SHADER, vs],
    [gl.FRAGMENT_SHADER, fs],
  ] as const) {
    const s = gl.createShader(type)!;
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(`shader: ${gl.getShaderInfoLog(s)}`);
    gl.attachShader(program, s);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(`program: ${gl.getProgramInfoLog(program)}`);
  return program;
}

function texture(gl: WebGL2RenderingContext, filter: number = gl.LINEAR): WebGLTexture {
  const t = gl.createTexture()!;
  gl.bindTexture(gl.TEXTURE_2D, t);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter === gl.NEAREST ? gl.NEAREST : gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return t;
}

export interface Capsule {
  a: Pt;
  b: Pt;
  r: number;
}

export interface FrameInput {
  video: HTMLVideoElement;
  crop: { sx: number; sy: number; sw: number; sh: number };
  mask: Uint8Array | null;
  maskWidth: number;
  maskHeight: number;
  /** Deformed garment mesh positions (crop pixels), or null to draw no garment. */
  positions: Float32Array | null;
  limbs: Capsule[];
  arms: Capsule[];
  torso: Pt[] | null;
  skin: [number, number, number];
  sceneLum: number;
  fill: [number, number, number];
  mirrored: boolean;
  takeOff: boolean;
  /** Show the body mask instead of the picture (developer view). */
  debug?: boolean;
  /** Colour of the person's own garment that the new one replaces, when known (0..1). */
  oldColour?: [number, number, number] | null;
  /** How far the body moved (crop pixels) since the camera frame the mask was made from. */
  maskShift?: Pt;
}

export interface MeshData {
  uv: Float32Array;
  torsoness: Float32Array;
  indices: Uint16Array;
}

export class MirrorRenderer {
  readonly gl: WebGL2RenderingContext;
  private readonly quad: WebGLVertexArrayObject;
  private readonly plateProg: WebGLProgram;
  private readonly meshProg: WebGLProgram;
  private readonly compProg: WebGLProgram;
  private readonly videoTex: WebGLTexture;
  private readonly maskTex: WebGLTexture;
  private readonly garmentTex: WebGLTexture;
  private plates: [WebGLTexture, WebGLTexture];
  private plateFbos: [WebGLFramebuffer, WebGLFramebuffer];
  private layerTex: WebGLTexture;
  private auxTex: WebGLTexture;
  private layerFbo: WebGLFramebuffer;
  private plateIndex = 0;
  private plateReady = false;
  private width = 0;
  private height = 0;
  private meshVao: WebGLVertexArrayObject | null = null;
  private meshPos: WebGLBuffer | null = null;
  private meshCount = 0;
  private readonly pixel = new Uint8Array(4);

  constructor(private readonly canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, preserveDrawingBuffer: true });
    if (!gl) throw new Error("this browser has WebGL 2 turned off, which the live mirror needs");
    this.gl = gl;
    this.plateProg = compile(gl, FULLSCREEN_VS, PLATE_FS);
    this.meshProg = compile(gl, MESH_VS, MESH_FS);
    this.compProg = compile(gl, FULLSCREEN_VS, COMPOSITE_FS);
    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    for (const prog of [this.plateProg, this.compProg]) {
      const loc = gl.getAttribLocation(prog, "aPos");
      if (loc >= 0) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
      }
    }
    gl.bindVertexArray(null);
    this.videoTex = texture(gl, gl.LINEAR_MIPMAP_LINEAR);
    this.maskTex = texture(gl, gl.NEAREST);
    this.garmentTex = texture(gl);
    this.plates = [texture(gl), texture(gl)];
    this.plateFbos = [gl.createFramebuffer()!, gl.createFramebuffer()!];
    this.layerTex = texture(gl);
    this.auxTex = texture(gl);
    this.layerFbo = gl.createFramebuffer()!;
  }

  /** Sets the output size (the camera crop) and resets the screen-sized buffers. */
  resize(width: number, height: number): void {
    const gl = this.gl;
    if (width === this.width && height === this.height) return;
    this.width = width;
    this.height = height;
    this.canvas.width = width;
    this.canvas.height = height;
    for (let i = 0; i < 2; i++) {
      gl.bindTexture(gl.TEXTURE_2D, this.plates[i]!);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.plateFbos[i]!);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.plates[i]!, 0);
    }
    for (const t of [this.layerTex, this.auxTex]) {
      gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, width, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    }
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerFbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, this.layerTex, 0);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT1, gl.TEXTURE_2D, this.auxTex, 0);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    this.plateReady = false;
  }

  /** Uploads a garment cut-out and its mesh (uv, torso weights, triangles). */
  setGarment(image: HTMLCanvasElement | null, mesh: MeshData | null): void {
    const gl = this.gl;
    if (!image || !mesh) {
      this.meshCount = 0;
      return;
    }
    gl.bindTexture(gl.TEXTURE_2D, this.garmentTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, image);
    const vao = gl.createVertexArray()!;
    gl.bindVertexArray(vao);
    const attrib = (name: string, data: Float32Array, size: number, usage: number) => {
      const loc = gl.getAttribLocation(this.meshProg, name);
      const buf = gl.createBuffer()!;
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, usage);
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, size, gl.FLOAT, false, 0, 0);
      return buf;
    };
    this.meshPos = attrib("aPos", new Float32Array(mesh.uv.length), 2, gl.DYNAMIC_DRAW);
    attrib("aUv", mesh.uv, 2, gl.STATIC_DRAW);
    attrib("aTorso", mesh.torsoness, 1, gl.STATIC_DRAW);
    const ib = gl.createBuffer()!;
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, ib);
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, mesh.indices, gl.STATIC_DRAW);
    gl.bindVertexArray(null);
    this.meshVao = vao;
    this.meshCount = mesh.indices.length;
  }

  /** Blocks until the GPU has drawn the frame. Only for the developer timings (#mirror-profile). */
  finish(): void {
    this.gl.readPixels(0, 0, 1, 1, this.gl.RGBA, this.gl.UNSIGNED_BYTE, this.pixel);
  }

  render(f: FrameInput): void {
    const gl = this.gl;
    const vw = f.video.videoWidth;
    const vh = f.video.videoHeight;
    if (!vw || !vh || !this.width) return;
    const crop = [f.crop.sx / vw, f.crop.sy / vh, f.crop.sw / vw, f.crop.sh / vh] as const;

    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.videoTex);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, f.video);
    gl.generateMipmap(gl.TEXTURE_2D);
    const hasMask = !!f.mask && f.mask.length === f.maskWidth * f.maskHeight;
    if (hasMask) {
      gl.activeTexture(gl.TEXTURE1);
      gl.bindTexture(gl.TEXTURE_2D, this.maskTex);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, f.maskWidth, f.maskHeight, 0, gl.RED, gl.UNSIGNED_BYTE, f.mask);
    }

    // 1. Background plate.
    const prev = this.plateIndex;
    const next = 1 - prev;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.plateFbos[next]!);
    gl.viewport(0, 0, this.width, this.height);
    gl.disable(gl.BLEND);
    gl.useProgram(this.plateProg);
    this.bind(this.plateProg, "uVideo", 0, this.videoTex);
    this.bind(this.plateProg, "uMask", 1, this.maskTex);
    this.bind(this.plateProg, "uPrev", 2, this.plates[prev]!);
    gl.uniform4f(gl.getUniformLocation(this.plateProg, "uCrop"), ...crop);
    gl.uniform1i(gl.getUniformLocation(this.plateProg, "uInit"), this.plateReady ? 0 : 1);
    gl.uniform1i(gl.getUniformLocation(this.plateProg, "uHasMask"), hasMask ? 1 : 0);
    gl.uniform3f(gl.getUniformLocation(this.plateProg, "uFill"), ...f.fill);
    const shift: [number, number] = f.maskShift && vw && vh ? [f.maskShift.x / vw, f.maskShift.y / vh] : [0, 0];
    gl.uniform2f(gl.getUniformLocation(this.plateProg, "uMaskShift"), ...shift);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    this.plateIndex = next;
    this.plateReady = true;

    // 2. Garment layer.
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.layerFbo);
    gl.drawBuffers([gl.COLOR_ATTACHMENT0, gl.COLOR_ATTACHMENT1]);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const garmentOn = !!(f.positions && this.meshVao && this.meshCount && this.meshPos);
    if (garmentOn) {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
      gl.useProgram(this.meshProg);
      gl.uniform2f(gl.getUniformLocation(this.meshProg, "uSize"), this.width, this.height);
      this.bind(this.meshProg, "uGarment", 0, this.garmentTex);
      gl.bindVertexArray(this.meshVao);
      gl.bindBuffer(gl.ARRAY_BUFFER, this.meshPos);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, f.positions!);
      gl.drawElements(gl.TRIANGLES, this.meshCount, gl.UNSIGNED_SHORT, 0);
      gl.disable(gl.BLEND);
    }

    // 3. Composite to the canvas.
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.width, this.height);
    const p = this.compProg;
    gl.useProgram(p);
    this.bind(p, "uVideo", 0, this.videoTex);
    this.bind(p, "uMask", 1, this.maskTex);
    this.bind(p, "uPlate", 2, this.plates[this.plateIndex]!);
    this.bind(p, "uLayer", 3, this.layerTex);
    this.bind(p, "uAux", 4, this.auxTex);
    const u = (name: string) => gl.getUniformLocation(p, name);
    gl.uniform4f(u("uCrop"), ...crop);
    gl.uniform2f(u("uSize"), this.width, this.height);
    gl.uniform1i(u("uMirror"), f.mirrored ? 1 : 0);
    gl.uniform1i(u("uTakeOff"), f.takeOff ? 1 : 0);
    gl.uniform1i(u("uGarmentOn"), garmentOn ? 1 : 0);
    gl.uniform1i(u("uHasMask"), hasMask ? 1 : 0);
    gl.uniform2f(u("uMaskShift"), ...shift);
    const limbs = new Float32Array(48);
    const limbR = new Float32Array(12);
    f.limbs.slice(0, 12).forEach((c, i) => {
      limbs.set([c.a.x, c.a.y, c.b.x, c.b.y], i * 4);
      limbR[i] = c.r;
    });
    gl.uniform4fv(u("uLimb"), limbs);
    gl.uniform1fv(u("uLimbR"), limbR);
    gl.uniform1i(u("uLimbN"), Math.min(12, f.limbs.length));
    const arms = new Float32Array(8);
    const armR = new Float32Array(2);
    f.arms.slice(0, 2).forEach((c, i) => {
      arms.set([c.a.x, c.a.y, c.b.x, c.b.y], i * 4);
      armR[i] = c.r;
    });
    gl.uniform4fv(u("uArm"), arms);
    gl.uniform1fv(u("uArmR"), armR);
    gl.uniform1i(u("uArmN"), Math.min(2, f.arms.length));
    const torso = new Float32Array(8);
    (f.torso ?? []).slice(0, 4).forEach((q, i) => torso.set([q.x, q.y], i * 2));
    gl.uniform2fv(u("uTorso"), torso);
    gl.uniform1i(u("uHasTorso"), f.torso && f.torso.length === 4 ? 1 : 0);
    gl.uniform3f(u("uSkin"), ...f.skin);
    gl.uniform1f(u("uSceneLum"), Math.max(0.05, f.sceneLum));
    const c = f.torso && f.torso.length ? f.torso.reduce((s, q) => ({ x: s.x + q.x / f.torso!.length, y: s.y + q.y / f.torso!.length }), { x: 0, y: 0 }) : { x: this.width / 2, y: this.height / 2 };
    gl.uniform2f(u("uCenter"), c.x, c.y);
    gl.uniform1i(u("uDebug"), f.debug ? 1 : 0);
    gl.uniform3f(u("uOld"), ...(f.oldColour ?? [0, 0, 0]));
    gl.uniform1i(u("uHasOld"), f.oldColour ? 1 : 0);
    gl.bindVertexArray(this.quad);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);
  }

  private bind(prog: WebGLProgram, name: string, unit: number, tex: WebGLTexture): void {
    const gl = this.gl;
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(gl.getUniformLocation(prog, name), unit);
  }
}
