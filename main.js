import * as THREE from './lib/three.module.min.js';

// ---------------------------------------------------------------------------
// setup

const $ = (s) => document.querySelector(s);
const canvas = $('#gl');
const coarse = matchMedia('(pointer: coarse)').matches;
const REDUCED = matchMedia('(prefers-reduced-motion: reduce)').matches;
// the saved single-file keepsake carries every asset inline
const KEEP = !!window.__ASSETS;
const asset = (p) => (KEEP && window.__ASSETS[p]) || p;
const LOWRES = !KEEP && (coarse || Math.min(innerWidth, innerHeight) < 700);
const TEX = LOWRES ? 'tex/m/' : 'tex/';

function showFallback() {
  $('#progress')?.classList.add('done');
  $('#fallback').hidden = false;
}

let renderer;
try {
  renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  if (!renderer.capabilities.isWebGL2) throw new Error('webgl2');
} catch (e) {
  showFallback();
  throw e;
}
// fixed resolution, never lowered at run time: phones get half-size textures
// instead, and a 3x screen draws at 2x, which every recent GPU handles at 60 fps
renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.NeutralToneMapping;
renderer.toneMappingExposure = 0.96;
const ANISO = renderer.capabilities.getMaxAnisotropy();

const manifest = await (await fetch(asset('manifest.json'))).json();
const CARD_W = manifest.card.w, CARD_H = manifest.card.h, THICK = manifest.card.thickness;
const PX = manifest.card.px_per_mm;
const TOP = Math.max(...manifest.layers.map((l) => l.z)) + 0.35;  // height of the stack

// ---------------------------------------------------------------------------
// textures: the scene is built at once on blank stand-ins; the real paintings
// stream in behind the opening paper, are decoded off the main thread, and are
// handed to the GPU one per frame, so nothing stalls when loading completes

const bar = $('#progress i');
const blank = new THREE.DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1);
blank.needsUpdate = true;
const loader = new THREE.TextureLoader();
const uploads = [];
const stream = { total: 0, done: 0, gobo: false };

function tex(name, { srgb = false, repeat = false } = {}, assign) {
  stream.total++;
  loader.load(asset(TEX + name), async (t) => {
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    if (repeat) t.wrapS = t.wrapT = THREE.RepeatWrapping;
    else t.wrapS = t.wrapT = THREE.ClampToEdgeWrapping;
    t.anisotropy = ANISO;
    t.generateMipmaps = true;
    t.minFilter = THREE.LinearMipmapLinearFilter;
    t.magFilter = THREE.LinearFilter;
    try { await t.image.decode?.(); } catch (e) { /* drawn anyway */ }
    uploads.push(() => {
      assign(t);
      renderer.initTexture(t);
      stream.done++;
      bar.style.width = `${(stream.done / stream.total) * 100}%`;
    });
  }, undefined, () => showFallback());
}

const WOOD = 'oak_veneer_01';

// ---------------------------------------------------------------------------
// scene

const scene = new THREE.Scene();
const camera = new THREE.PerspectiveCamera(26, 1, 5, 8000);
camera.up.set(0, 1, 0);

const U = {
  uTime: { value: 0 },
  uSunDir: { value: new THREE.Vector3(-0.46, 0.42, 0.78).normalize() },
  uSunCol: { value: new THREE.Color(1.0, 0.92, 0.80).multiplyScalar(1.95) },
  uSkyCol: { value: new THREE.Color(0.64, 0.69, 0.78).multiplyScalar(0.66) },
  uBounce: { value: new THREE.Color(0.55, 0.40, 0.28).multiplyScalar(0.25) },
  uGobo: { value: blank },
  uCamPos: { value: camera.position },
  uCardInv: { value: new THREE.Matrix4() },
  uCardRot: { value: new THREE.Matrix3() },
  uCardInvRot: { value: new THREE.Matrix3() },
  uPaper: { value: blank },
  uTilePx: { value: new THREE.Vector2(...manifest.paper.tile_px) },
  uPx: { value: PX },
  uShA: { value: blank },
  uShB: { value: blank },
  uAOA: { value: blank },
  uAOB: { value: blank },
  uCard: { value: new THREE.Vector2(CARD_W, CARD_H) },
  uReveal: { value: 0 },
  uGhostShade: { value: 0 },
  uGhostPaper: { value: new THREE.Color('#ece3d1') },   // linear; the page background before WebGL
  uInvViewProj: { value: new THREE.Matrix4() },
  uRes: { value: new THREE.Vector2(1, 1) },
};
// heights / shadow strengths of the sheets packed in the two shadow atlases
const order = manifest.shadow.order;
const zOf = (n) => manifest.layers.find((l) => l.name === n)?.z ?? -1;
const wOf = (n) => (manifest.layers.find((l) => l.name === n)?.vellum ? 0.3 : 0.93);
const zA = new THREE.Vector4(), zB = new THREE.Vector4(-1, -1, -1, -1);
const wA = new THREE.Vector4(), wB = new THREE.Vector4(0, 0, 0, 0);
order.forEach((n, i) => {
  if (i < 4) { zA.setComponent(i, zOf(n)); wA.setComponent(i, wOf(n)); }
  else { zB.setComponent(i - 4, zOf(n)); wB.setComponent(i - 4, wOf(n)); }
});
Object.assign(U, { uZA: { value: zA }, uZB: { value: zB }, uWA: { value: wA }, uWB: { value: wB } });

// ---------------------------------------------------------------------------
// GLSL

const COMMON = /* glsl */`
uniform float uTime;
uniform vec3 uSunDir;
uniform vec3 uSunCol;
uniform vec3 uSkyCol;
uniform vec3 uBounce;
uniform sampler2D uGobo;
uniform vec3 uCamPos;
#define PI 3.14159265

float goboAt(vec2 q, float scale, float blurMM) {
  float texel = scale / 1024.0;
  float lod = log2(max(blurMM / texel, 1.0));
  return textureLod(uGobo, q / scale, lod).r;
}
float rectSoft(vec2 p, vec2 halfSize, float soft) {
  vec2 d = abs(p) - halfSize;
  float dist = length(max(d, 0.0)) + min(max(d.x, d.y), 0.0);
  return 1.0 - smoothstep(-soft, soft, dist);
}
vec2 rot2(vec2 p, float a) { float s = sin(a), c = cos(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
// sunlight that gets through the window and the leaves of the tree outside
float sunVis(vec3 P) {
  vec2 q = P.xy - uSunDir.xy / max(uSunDir.z, 0.05) * P.z;   // where the ray meets the desk
  float t = uTime;
  // the bough swings slowly about where it meets the tree; its leaves flutter
  float sway = 0.017 * sin(t * 0.52) + 0.007 * sin(t * 1.31 + 1.1) + 0.003 * sin(t * 2.7 + 0.3);
  vec2 qn = rot2(q - vec2(-430.0, 390.0), sway) + vec2(-430.0, 390.0);
  qn += vec2(sin(t * 1.7) * 1.1 + sin(t * 2.9 + 0.4) * 0.5, cos(t * 1.45) * 0.9 + sin(t * 2.3 + 1.7) * 0.4);
  vec2 qf = rot2(q * 0.8 - vec2(-300.0, 300.0), sway * 0.6 + 0.009 * sin(t * 0.37 + 2.0)) + vec2(-300.0, 300.0);
  qf += vec2(sin(t * 0.19 + 2.0) * 6.0, cos(t * 0.23 + 0.7) * 4.0);
  float nearL = goboAt(qn + vec2(37.0, 11.0), 270.0, 2.6);
  float farL = goboAt(qf + vec2(140.0, 70.0), 520.0, 13.0);
  float leaves = nearL * mix(1.0, farL, 0.55);
  leaves = smoothstep(0.05, 0.92, leaves);
  // the window opening and its mullions, projected on the desk
  vec2 c = vec2(-40.0, 35.0);
  float a = 0.30;
  vec2 w = mat2(cos(a), -sin(a), sin(a), cos(a)) * (q - c);
  float win = rectSoft(w, vec2(300.0, 215.0), 34.0);
  float mull = smoothstep(6.0, 15.0, abs(w.x + 175.0)) * smoothstep(6.0, 14.0, abs(w.y + 150.0));
  return win * mull * mix(0.24, 1.0, leaves);
}
float D_GGX(float NoH, float a) { float a2 = a * a; float d = NoH * NoH * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
float V_Smith(float NoV, float NoL, float a) {
  float a2 = a * a;
  float gv = NoL * sqrt(NoV * NoV * (1.0 - a2) + a2);
  float gl = NoV * sqrt(NoL * NoL * (1.0 - a2) + a2);
  return 0.5 / max(gv + gl, 1e-4);
}
vec3 F_Schlick(vec3 f0, float VoH) { return f0 + (1.0 - f0) * pow(1.0 - VoH, 5.0); }
vec3 specSun(vec3 N, vec3 V, vec3 L, float rough, vec3 f0) {
  vec3 H = normalize(V + L);
  float NoL = max(dot(N, L), 0.0), NoV = max(dot(N, V), 1e-3), NoH = max(dot(N, H), 0.0), VoH = max(dot(V, H), 0.0);
  float a = rough * rough;
  return D_GGX(NoH, a) * V_Smith(NoV, NoL, a) * F_Schlick(f0, VoH) * NoL;
}
vec3 envRefl(vec3 R, float rough) {
  float up = R.z * 0.5 + 0.5;
  vec3 room = mix(vec3(0.16, 0.12, 0.09), vec3(0.95, 0.90, 0.82), smoothstep(0.1, 1.0, up));
  float win = pow(max(dot(R, uSunDir), 0.0), mix(300.0, 6.0, rough));
  return room * 0.55 + uSunCol * win * 0.6;
}
`;

// the opening. First the page is blank paper with the tree's shadows moving
// on it (the same light the scene is lit by, found where the view ray meets the
// desk, so every surface shows the identical paper); then colour blooms into
// the wet paper from a few brush touches, spreading with a soft, slightly
// darker drying rim, until the painting is whole. Mixed after tone mapping so
// the blank paper is exactly the page's background colour.
const BLOOM = /* glsl */`
uniform float uReveal;
uniform vec2 uRes;
float rvHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float rvNoise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3.0 - 2.0 * f);
  return mix(mix(rvHash(i), rvHash(i + vec2(1.0, 0.0)), f.x), mix(rvHash(i + vec2(0.0, 1.0)), rvHash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float rvFbm(vec2 p) { float s = 0.0, a = 0.5; for (int i = 0; i < 4; i++) { s += a * rvNoise(p); p *= 2.03; a *= 0.5; } return s; }
// x: wetness (0 dry paper, 1 colour arrived), y: drying rim, z: how long colour has flowed here
vec3 bloomAt(vec2 frag) {
  float asp = uRes.x / uRes.y;
  vec2 p = (frag / uRes - 0.5) * vec2(asp, 1.0);
  float d = 1e3;
  vec3 seeds[4];
  seeds[0] = vec3(-0.08, 0.06, 0.00);
  seeds[1] = vec3(0.28 * asp, -0.16, 0.16);
  seeds[2] = vec3(-0.34 * asp, -0.28, 0.28);
  seeds[3] = vec3(0.20 * asp, 0.36, 0.40);
  float reach = 0.5 * length(vec2(asp, 1.0)) + 0.75;
  for (int i = 0; i < 4; i++) {
    float t = clamp((uReveal - seeds[i].z) / (1.0 - seeds[i].z), 0.0, 1.0);
    // a drop of colour spreads fast at first touch, then creeps as the paper drinks it
    float r = (0.18 * (1.0 - exp(-t * 9.0)) + 0.82 * t * t * (3.0 - 2.0 * t)) * reach * (i == 0 ? 1.15 : 0.8);
    d = min(d, length(p - seeds[i].xy) - r);
  }
  d += (rvFbm(p * 3.1 + 1.7) - 0.5) * 0.17 + (rvFbm(p * 15.0) - 0.5) * 0.035;
  float wet = smoothstep(0.010, -0.010, d);
  float rim = exp(-abs(d + 0.012) / 0.018) * wet;
  return vec3(wet, rim, smoothstep(0.0, 0.32, -d));
}
`;
const REVEAL = /* glsl */`
${BLOOM}
uniform float uGhostShade;
uniform vec3 uGhostPaper;
uniform mat4 uInvViewProj;
vec3 ghostAt(vec2 frag) {
  vec2 ndc = frag / uRes * 2.0 - 1.0;
  vec4 a = uInvViewProj * vec4(ndc, -1.0, 1.0); a /= a.w;
  vec4 b = uInvViewProj * vec4(ndc, 1.0, 1.0); b /= b.w;
  vec3 dir = b.xyz - a.xyz;
  vec3 P = a.xyz - dir * (a.z / dir.z);
  float light = mix(0.72, 1.0, sunVis(vec3(P.xy, 0.0)));
  return uGhostPaper * mix(1.0, light, uGhostShade);
}
vec3 revealMix(vec3 col, vec2 frag) {
  if (uReveal >= 1.0) return col;
  vec3 ghost = ghostAt(frag);
  if (uReveal <= 0.0) return ghost;
  vec3 b = bloomAt(frag);
  vec3 wash = mix(ghost, col, 0.5);
  vec3 c = mix(ghost, mix(wash, col, b.z), b.x);
  return c * (1.0 - b.y * 0.17);
}
`;

const SHEET_VS = /* glsl */`
uniform vec4 uBox;          // sheet rectangle on the card, mm (x0, y0, x1, y1), y down
uniform float uUvRot;       // 1: the painting is turned half round on its sheet
varying vec2 vUv;
varying vec2 vCard;
varying vec3 vWorld;
void main() {
  vec2 st = uUvRot > 0.5 ? 1.0 - uv : uv;
  vUv = st;
  vCard = vec2(mix(uBox.x, uBox.z, st.x), mix(uBox.w, uBox.y, st.y));
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const SHEET_FS = /* glsl */`
${COMMON}
${REVEAL}
uniform sampler2D uAlbedo;
uniform sampler2D uAux;
uniform float uHasAux;
uniform sampler2D uPaper;
uniform vec2 uTilePx;
uniform float uPx;
uniform vec2 uPaperOff;
uniform float uZ;
uniform float uIsBack;
uniform float uVellum;
uniform float uUvRot;
uniform vec2 uCard;
uniform mat3 uCardRot;
uniform mat3 uCardInvRot;
uniform sampler2D uShA;
uniform sampler2D uShB;
uniform vec4 uZA, uZB, uWA, uWB;
uniform sampler2D uAOTex;
uniform vec4 uAOSel;
varying vec2 vUv;
varying vec2 vCard;
varying vec3 vWorld;

vec2 atlasUv(vec2 cardPos) { return vec2(cardPos.x / uCard.x, 1.0 - cardPos.y / uCard.y); }

// soft shadow cast by a higher sheet onto this one (parallel planes)
float shade1(float a, float w) { return 1.0 - a * w; }
float upperShadow(vec2 k) {
  float vis = 1.0;
  for (int i = 0; i < 4; i++) {
    float dz = uZA[i] - uZ;
    if (dz > 0.05 && uWA[i] > 0.0) {
      vec2 p = vCard + vec2(k.x, -k.y) * dz;
      float pen = 0.16 + dz * 0.032;
      vis *= shade1(textureLod(uShA, atlasUv(p), log2(max(pen / 0.134, 1.0)))[i], uWA[i]);
    }
    dz = uZB[i] - uZ;
    if (dz > 0.05 && uWB[i] > 0.0) {
      vec2 p = vCard + vec2(k.x, -k.y) * dz;
      float pen = 0.16 + dz * 0.032;
      vis *= shade1(textureLod(uShB, atlasUv(p), log2(max(pen / 0.134, 1.0)))[i], uWB[i]);
    }
  }
  return vis;
}
// sky light partly blocked by the sheets floating above (static, baked)
float upperAO() {
  return dot(texture(uAOTex, atlasUv(vCard)), uAOSel);
}

void main() {
  vec4 alb = texture(uAlbedo, vUv);
  float cov = alb.a;
  float alpha = cov;
  if (uVellum < 0.5) {
    float aw = max(fwidth(cov), 1e-4);
    alpha = clamp((cov - 0.5) / aw + 0.5, 0.0, 1.0);
    if (alpha <= 0.001) discard;
  } else if (cov < 0.004) discard;
  bool under = !gl_FrontFacing;                 // the plain reverse of a cut-out sheet
  vec3 base = alb.rgb;
  if (uVellum > 0.5) base = vec3(0.93, 0.92, 0.89);
  if (under && uVellum < 0.5) base = vec3(0.83, 0.78, 0.68);

  // cotton paper tooth (the same paper the paint granulated into)
  vec2 tp = (vCard * uPx + uPaperOff) / uTilePx;
  tp.y = 1.0 - tp.y;
  vec3 pt = texture(uPaper, tp).xyz;
  vec3 nl = vec3((pt.xy * 2.0 - 1.0) * 0.85, 1.0);
  float metal = 0.0, gloss = 0.0;
  if (uHasAux > 0.5) {
    vec4 ax = texture(uAux, vUv);
    nl.xy += (ax.xy * 2.0 - 1.0) * 1.4;
    metal = ax.z;
    gloss = ax.w;
  }
  if (uUvRot > 0.5) nl.xy = -nl.xy;
  nl = normalize(nl);
  if (under) nl.z = -nl.z;
  if (uIsBack > 0.5) nl.x = -nl.x;
  vec3 N = normalize(uCardRot * (uIsBack > 0.5 ? vec3(nl.x, nl.y, -nl.z) : nl));

  vec3 L = uSunDir;
  vec3 V = normalize(uCamPos - vWorld);
  vec3 dl = uCardInvRot * L;
  float facing = (uIsBack > 0.5 || under) ? -dl.z : dl.z;
  float vis = sunVis(vWorld) * smoothstep(0.0, 0.06, facing);
  float ao = 1.0;
  if (uIsBack < 0.5 && !under) {
    vec2 k = dl.xy / max(dl.z, 0.06);
    vis *= upperShadow(k);
    ao = upperAO();
  }
  float NoL = max(dot(N, L), 0.0);
  float wrap = max(dot(N, L) * 0.5 + 0.5, 0.0);
  float diff = NoL * 0.86 + wrap * 0.10;
  vec3 sky = uSkyCol * (0.58 + 0.42 * N.z) * ao + uBounce * max(-N.z, 0.0);
  vec3 col = base * (uSunCol * diff * vis + sky);
  // thin paper glows a little when the sun is behind it
  col += base * uSunCol * 0.06 * max(-dot(N, L), 0.0) * sunVis(vWorld);
  float rough = mix(0.78, 0.40, gloss);
  col += specSun(N, V, L, rough, vec3(0.03 + 0.03 * gloss)) * uSunCol * vis * (0.55 + 0.9 * gloss);
  if (metal > 0.01) {
    vec3 gold = vec3(0.92, 0.70, 0.36);
    vec3 R = reflect(-V, N);
    vec3 m = gold * envRefl(R, 0.32) * 0.95 + specSun(N, V, L, 0.30, gold) * uSunCol * vis * 1.2 + gold * sky * 0.08;
    col = mix(col, m, metal);
  }
  float outA = uVellum > 0.5 ? clamp(cov * 1.05, 0.0, 0.92) : alpha;
  gl_FragColor = vec4(col, outA);
  #include <tonemapping_fragment>
  gl_FragColor.rgb = revealMix(gl_FragColor.rgb, gl_FragCoord.xy);
  #include <colorspace_fragment>
}
`;

const EDGE_FS = /* glsl */`
${COMMON}
${REVEAL}
uniform mat3 uCardRot;
varying vec3 vN;
varying vec3 vWorld;
void main() {
  vec3 N = normalize(vN);
  vec3 L = uSunDir;
  float vis = sunVis(vWorld);
  vec3 base = vec3(0.86, 0.82, 0.73);
  vec3 col = base * (uSunCol * max(dot(N, L), 0.0) * vis + uSkyCol * (0.6 + 0.4 * N.z));
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  gl_FragColor.rgb = revealMix(gl_FragColor.rgb, gl_FragCoord.xy);
  #include <colorspace_fragment>
}
`;
const EDGE_VS = /* glsl */`
varying vec3 vN;
varying vec3 vWorld;
void main() {
  vN = normalize(mat3(modelMatrix) * normal);
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const DESK_VS = /* glsl */`
varying vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const CARD_SHADOW = /* glsl */`
uniform mat4 uCardInv;
uniform mat3 uCardInvRot;
uniform vec2 uCard;
uniform float uThick;
// the card's sheet as a soft-edged occluder of a ray (P, dir)
float cardHit(vec3 P, vec3 dir, float softBase, float softPerMM, out float dist) {
  vec3 o = (uCardInv * vec4(P, 1.0)).xyz;
  vec3 d = uCardInvRot * dir;
  dist = 0.0;
  if (abs(d.z) < 1e-4) return 0.0;
  float t = (-uThick * 0.5 - o.z) / d.z;
  if (t <= 0.0) return 0.0;
  dist = t;
  vec2 h = o.xy + d.xy * t;
  return rectSoft(h, uCard * 0.5, softBase + t * softPerMM);
}
// direct sun and sky occlusion the floating card throws on what lies below
void cardShade(vec3 P, vec3 L, out float sh, out float ao) {
  float d1, d2, d3;
  sh = 1.0 - cardHit(P, L, 0.7, 0.03, d1) * 0.94;
  float occ = cardHit(P, vec3(0.0, 0.0, 1.0), 2.0, 0.85, d2);
  ao = 1.0 - occ * 0.62 * exp(-d2 / 70.0);
  float contact = cardHit(P, vec3(0.0, 0.0, 1.0), 0.6, 0.15, d3);
  ao *= 1.0 - contact * 0.35 * exp(-d3 / 2.5);
}
`;

const DESK_FS = /* glsl */`
${COMMON}
${REVEAL}
${CARD_SHADOW}
uniform sampler2D uWoodD;
uniform sampler2D uWoodN;
uniform sampler2D uWoodR;
uniform vec4 uEnvXf;   // envelope: centre x, y, cos, sin
uniform vec2 uEnvSize;
varying vec3 vWorld;

void main() {
  vec3 P = vWorld;
  vec2 uv = P.xy / 520.0 + vec2(0.31, 0.17);
  vec3 alb = texture(uWoodD, uv).rgb;
  alb = mix(vec3(dot(alb, vec3(0.3, 0.59, 0.11))), alb, 0.78) * 1.04;
  vec3 nt = texture(uWoodN, uv).xyz * 2.0 - 1.0;
  vec3 N = normalize(vec3(nt.xy * 0.7, nt.z));
  float rough = clamp(texture(uWoodR, uv).r * 0.9 + 0.08, 0.25, 1.0);
  vec3 L = uSunDir;
  vec3 V = normalize(uCamPos - P);
  float sh, ao;
  cardShade(P, L, sh, ao);
  // the envelope lying on the desk: a thin contact shadow along its edges
  vec2 el = P.xy - uEnvXf.xy;
  el = vec2(el.x * uEnvXf.z + el.y * uEnvXf.w, -el.x * uEnvXf.w + el.y * uEnvXf.z);
  float env = rectSoft(el, vec2(uEnvSize.x * 0.5, uEnvSize.y * 0.5), 1.4);
  // the open flap, roughly a triangle above the body
  float fy = (el.y - uEnvSize.y * 0.5) / 84.0;
  env = max(env, step(0.0, fy) * (1.0 - smoothstep(-1.4, 1.4, abs(el.x) - uEnvSize.x * 0.5 * (1.0 - fy))));
  ao *= 1.0 - env * 0.26;
  float vis = sunVis(P) * sh;
  float NoL = max(dot(N, L), 0.0);
  vec3 col = alb * (uSunCol * NoL * vis + uSkyCol * (0.6 + 0.4 * N.z) * ao);
  col += specSun(N, V, L, rough, vec3(0.04)) * uSunCol * vis * 0.9;
  vec3 R = reflect(-V, N);
  col += F_Schlick(vec3(0.04), max(dot(N, V), 0.0)) * envRefl(R, rough) * 0.25 * ao;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  gl_FragColor.rgb = revealMix(gl_FragColor.rgb, gl_FragCoord.xy);
  #include <colorspace_fragment>
}
`;

// ---------------------------------------------------------------------------
// desk

const desk = new THREE.Mesh(
  new THREE.PlaneGeometry(2600, 1800),
  new THREE.ShaderMaterial({
    uniforms: {
      ...U,
      uWoodD: { value: blank }, uWoodN: { value: blank }, uWoodR: { value: blank },
      uThick: { value: THICK },
    },
    vertexShader: DESK_VS,
    fragmentShader: DESK_FS,
  }),
);
desk.renderOrder = 40;
scene.add(desk);

// ---------------------------------------------------------------------------
// envelope (sage, lying open under the card; its flap lined with painted leaves)

const ENV = { w: 200, h: 146, flap: 84, x: -46, y: 8, rot: 0.13 };
const ENV_FS = /* glsl */`
${COMMON}
${REVEAL}
${CARD_SHADOW}
uniform sampler2D uPaper;
uniform vec2 uTilePx;
uniform float uPx;
uniform vec2 uEnvSize;
varying vec3 vWorld;
varying vec2 vLocal;
float line(vec2 p, vec2 a, vec2 b, float w) {
  vec2 pa = p - a, ba = b - a;
  float h = clamp(dot(pa, ba) / dot(ba, ba), 0.0, 1.0);
  return 1.0 - smoothstep(0.0, w, length(pa - ba * h));
}
void main() {
  vec2 p = vLocal;
  float W = uEnvSize.x, H = uEnvSize.y;
  bool flap = p.y > H * 0.5;
  vec3 sage = pow(vec3(0.56, 0.57, 0.47), vec3(2.2));
  vec3 cream = pow(vec3(0.92, 0.89, 0.81), vec3(2.2));
  vec3 leaf = pow(vec3(0.58, 0.62, 0.50), vec3(2.2));
  vec3 alb = sage;
  if (flap) {
    // liner: a hand-painted leaf print on cream
    float lv = textureLod(uGobo, p / 190.0 + vec2(0.21, 0.63), 0.4).r;
    alb = mix(leaf, cream, smoothstep(0.35, 0.65, lv));
  }
  vec2 tp = (p + 400.0) * uPx / uTilePx;
  vec3 pt = texture(uPaper, tp).xyz;
  vec3 n = normalize(vec3((pt.xy * 2.0 - 1.0) * 0.8, 1.0));
  // folds of the envelope back: bottom flap V and side flap seams
  vec2 apex = vec2(0.0, H * 0.06);
  float seam = max(line(p, vec2(-W * 0.5, -H * 0.5), apex, 0.9), line(p, vec2(W * 0.5, -H * 0.5), apex, 0.9));
  float sideL = line(p, vec2(-W * 0.5, H * 0.5), vec2(-W * 0.18, H * 0.02), 0.8);
  float sideR = line(p, vec2(W * 0.5, H * 0.5), vec2(W * 0.18, H * 0.02), 0.8);
  float hinge = 1.0 - smoothstep(0.0, 1.6, abs(p.y - H * 0.5));
  float creases = flap ? hinge : max(max(seam, max(sideL, sideR) * 0.6), hinge);
  // the edge of an overlapping flap throws a hairline shadow below it
  float under = 0.0;
  if (!flap) {
    float dl = dot(p - vec2(-W * 0.5, -H * 0.5), normalize(vec2(-(apex.y + H * 0.5), W * 0.5)));
    float dr = dot(p - vec2(W * 0.5, -H * 0.5), normalize(vec2(apex.y + H * 0.5, W * 0.5)));
    under = (smoothstep(-2.5, 0.0, -dl) * (1.0 - smoothstep(0.0, 2.5, -dl)) +
             smoothstep(-2.5, 0.0, -dr) * (1.0 - smoothstep(0.0, 2.5, -dr))) * step(p.y, apex.y);
  }
  vec3 N = n;
  vec3 L = uSunDir;
  float sh, ao;
  cardShade(vWorld, L, sh, ao);
  float vis = sunVis(vWorld) * sh;
  vec3 col = alb * (uSunCol * max(dot(N, L), 0.0) * vis + uSkyCol * (0.6 + 0.4 * N.z) * ao);
  col *= 1.0 - creases * 0.10 - under * 0.12;
  vec3 V = normalize(uCamPos - vWorld);
  col += specSun(N, V, L, 0.7, vec3(0.03)) * uSunCol * vis * 0.5;
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  gl_FragColor.rgb = revealMix(gl_FragColor.rgb, gl_FragCoord.xy);
  #include <colorspace_fragment>
}
`;
{
  const { w, h, flap } = ENV;
  const sh = new THREE.Shape();
  sh.moveTo(-w / 2, -h / 2);
  sh.lineTo(w / 2, -h / 2);
  sh.lineTo(w / 2, h / 2);
  sh.lineTo(w * 0.07, h / 2 + flap - 5);
  sh.quadraticCurveTo(0, h / 2 + flap + 1.5, -w * 0.07, h / 2 + flap - 5);
  sh.lineTo(-w / 2, h / 2);
  sh.closePath();
  const geo = new THREE.ShapeGeometry(sh, 16);
  const mat = new THREE.ShaderMaterial({
    uniforms: { ...U, uThick: { value: THICK }, uEnvSize: { value: new THREE.Vector2(w, h) } },
    vertexShader: /* glsl */`
      varying vec3 vWorld;
      varying vec2 vLocal;
      void main() {
        vLocal = position.xy;
        vec4 wp = modelMatrix * vec4(position, 1.0);
        vWorld = wp.xyz;
        gl_Position = projectionMatrix * viewMatrix * wp;
      }`,
    fragmentShader: ENV_FS,
  });
  const env = new THREE.Mesh(geo, mat);
  env.position.set(ENV.x, ENV.y, 0.32);
  env.rotation.z = ENV.rot;
  env.renderOrder = 30;
  scene.add(env);
  desk.material.uniforms.uEnvXf = { value: new THREE.Vector4(ENV.x, ENV.y, Math.cos(ENV.rot), Math.sin(ENV.rot)) };
  desk.material.uniforms.uEnvSize = { value: new THREE.Vector2(w, h) };
}

// ---------------------------------------------------------------------------
// card

const card = new THREE.Group();
scene.add(card);
const sheets = [];   // [mesh, height] for draw ordering
const faceMesh = [null, null];
const layerMesh = [];

function aoSlot(name) {
  const i = Math.max(0, manifest.ao.order.indexOf(name ?? 'base'));
  const sel = new THREE.Vector4(); sel.setComponent(i % 4, 1);
  return { tex: i < 4 ? U.uAOA : U.uAOB, sel };
}
function sheetMaterial(albedo, opts) {
  const m = new THREE.ShaderMaterial({
    uniforms: {
      ...U,
      uAlbedo: { value: albedo },
      uAux: { value: opts.aux || albedo },
      uHasAux: { value: opts.aux ? 1 : 0 },
      uPaperOff: { value: new THREE.Vector2(...opts.paperOffset) },
      uZ: { value: opts.z },
      uIsBack: { value: opts.isBack ? 1 : 0 },
      uVellum: { value: opts.vellum ? 1 : 0 },
      uBox: { value: new THREE.Vector4(...opts.box) },
      uUvRot: { value: 0 },
      uAOTex: aoSlot(opts.name).tex,
      uAOSel: { value: aoSlot(opts.name).sel },
    },
    vertexShader: SHEET_VS,
    fragmentShader: SHEET_FS,
    side: opts.side ?? THREE.FrontSide,
    transparent: !!opts.vellum,
    depthWrite: !opts.vellum,
    alphaToCoverage: !opts.vellum,
  });
  if (!opts.vellum) {
    // the cut edges use alpha-to-coverage; keep their alpha out of the canvas,
    // or the page compositor would lighten every edge pixel
    Object.assign(m, {
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
      blendSrc: THREE.OneFactor, blendDst: THREE.ZeroFactor,
      blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
    });
  }
  return m;
}

// base sheet: front, back and its cut edges
{
  const front = faceMesh[0] = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H),
    sheetMaterial(blank, { name: 'base', aux: blank, paperOffset: manifest.base.paper_offset, z: 0, box: [0, 0, CARD_W, CARD_H] }));
  card.add(front);
  sheets.push([front, 0]);
  const back = faceMesh[1] = new THREE.Mesh(new THREE.PlaneGeometry(CARD_W, CARD_H),
    sheetMaterial(blank, { aux: blank, paperOffset: manifest.back.paper_offset, z: 0, isBack: true, box: [0, 0, CARD_W, CARD_H] }));
  back.rotation.y = Math.PI;
  back.position.z = -THICK;
  card.add(back);
  sheets.push([back, -1]);
  const edgeMat = new THREE.ShaderMaterial({ uniforms: { ...U }, vertexShader: EDGE_VS, fragmentShader: EDGE_FS });
  const hidden = new THREE.MeshBasicMaterial({ visible: false });
  const slab = new THREE.Mesh(new THREE.BoxGeometry(CARD_W, CARD_H, THICK),
    [edgeMat, edgeMat, edgeMat, edgeMat, hidden, hidden]);
  slab.position.z = -THICK / 2;
  card.add(slab);
}
// raised, hand-cut sheets
manifest.layers.forEach((l, i) => {
  const [x0, y0, x1, y1] = l.box_mm;
  const w = x1 - x0, h = y1 - y0;
  const mesh = new THREE.Mesh(new THREE.PlaneGeometry(w, h),
    sheetMaterial(blank, { name: l.name, paperOffset: l.paper_offset, z: l.z, box: [x0, y0, x1, y1], vellum: l.vellum, side: THREE.DoubleSide }));
  mesh.position.set((x0 + x1) / 2 - CARD_W / 2, CARD_H / 2 - (y0 + y1) / 2, l.z);
  card.add(mesh);
  layerMesh[i] = mesh;
  if (!l.vellum) sheets.push([mesh, l.z]); else mesh.renderOrder = 50;
});

// dust in the sunbeam
const DUST = LOWRES ? 70 : 140;
{
  const g = new THREE.BufferGeometry();
  const pos = new Float32Array(DUST * 3), seed = new Float32Array(DUST);
  for (let i = 0; i < DUST; i++) {
    pos[i * 3] = (Math.random() - 0.5) * 520;
    pos[i * 3 + 1] = (Math.random() - 0.5) * 360;
    pos[i * 3 + 2] = 20 + Math.random() * 260;
    seed[i] = Math.random();
  }
  g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  g.setAttribute('seed', new THREE.BufferAttribute(seed, 1));
  const m = new THREE.ShaderMaterial({
    uniforms: { ...U, uScale: { value: 1 } },
    vertexShader: /* glsl */`
      ${COMMON}
      uniform float uScale;
      attribute float seed;
      varying float vA;
      void main() {
        vec3 p = position;
        float t = uTime * (0.05 + seed * 0.05);
        p += vec3(sin(t * 3.1 + seed * 40.0) * 18.0, cos(t * 2.3 + seed * 17.0) * 14.0, sin(t * 1.7 + seed * 9.0) * 22.0);
        vec4 mv = viewMatrix * vec4(p, 1.0);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uScale * (0.9 + seed * 1.6) * 400.0 / -mv.z;
        vA = sunVis(p) * (0.25 + 0.75 * fract(seed * 7.13)) * (0.5 + 0.5 * sin(uTime * (0.6 + seed) + seed * 30.0));
      }`,
    fragmentShader: /* glsl */`
      ${BLOOM}
      varying float vA;
      void main() {
        float d = length(gl_PointCoord - 0.5);
        float a = smoothstep(0.5, 0.0, d) * vA * 0.55 * (uReveal >= 1.0 ? 1.0 : bloomAt(gl_FragCoord.xy).x);
        gl_FragColor = vec4(vec3(1.0, 0.93, 0.80) * a, a);
      }`,
    transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
  });
  const pts = new THREE.Points(g, m);
  pts.frustumCulled = false;
  pts.renderOrder = 3;
  scene.add(pts);
  U.uDustScale = m.uniforms.uScale;
}

// ---------------------------------------------------------------------------
// stream the paintings in (the leaf shadows first: the opening uses them)

tex('gobo.png', { repeat: true }, (t) => { U.uGobo.value = t; stream.gobo = true; });
tex(manifest.paper.tex, { repeat: true }, (t) => { U.uPaper.value = t; });
tex(manifest.shadow.a, {}, (t) => { U.uShA.value = t; });
tex(manifest.shadow.b, {}, (t) => { U.uShB.value = t; });
tex(manifest.ao.a, {}, (t) => { U.uAOA.value = t; });
tex(manifest.ao.b, {}, (t) => { U.uAOB.value = t; });
tex(manifest.base.albedo, { srgb: true }, (t) => { faceMesh[0].material.uniforms.uAlbedo.value = t; });
tex(manifest.base.aux, {}, (t) => { faceMesh[0].material.uniforms.uAux.value = t; });
tex(manifest.back.albedo, { srgb: true }, (t) => { faceMesh[1].material.uniforms.uAlbedo.value = t; });
tex(manifest.back.aux, {}, (t) => { faceMesh[1].material.uniforms.uAux.value = t; });
tex(`${WOOD}_diff_2k.jpg`, { srgb: true, repeat: true }, (t) => { desk.material.uniforms.uWoodD.value = t; });
tex(`${WOOD}_nor_gl_2k.jpg`, { repeat: true }, (t) => { desk.material.uniforms.uWoodN.value = t; });
tex(`${WOOD}_rough_2k.jpg`, { repeat: true }, (t) => { desk.material.uniforms.uWoodR.value = t; });
manifest.layers.forEach((l, i) => tex(l.albedo, { srgb: true }, (t) => { layerMesh[i].material.uniforms.uAlbedo.value = t; }));

// ---------------------------------------------------------------------------
// interaction state

const S = {
  px: 0, py: 0, tx: 0, ty: 0,          // tilt input (smoothed / target), -1..1
  lastMove: -1e9,
  lift: 0, liftT: 0,
  rx: 0, ry: 0,
  face: 0, flipping: false, settle: 0, settleV: 0,
  gyro: null, gyroAsked: false,
  mouse: !coarse,
};
// zoom: 1 shows the whole card; panning only exists while zoomed in
const Z = { z: 1, zT: 1, x: 0, y: 0, xT: 0, yT: 0, min: 1, max: 3.4 };
const hint = $('#hint');
const saveBtn = $('#save');

function clampPan() {
  const k = 1 - 1 / Z.zT;
  const mx = (CARD_W / 2 + 6) * k, my = (CARD_H / 2 + 6) * k;
  Z.xT = THREE.MathUtils.clamp(Z.xT, -mx, mx);
  Z.yT = THREE.MathUtils.clamp(Z.yT, -my, my);
}
// phones start with half-size textures; zooming in on a face fetches that
// face's full-size painting once, so small writing stays crisp
const sharpFace = [false, false];
function sharpen(face) {
  if (!LOWRES || sharpFace[face]) return;
  sharpFace[face] = true;
  const name = face ? manifest.back.albedo : manifest.base.albedo;
  new THREE.TextureLoader().load('tex/' + name, (t) => {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = ANISO;
    const u = faceMesh[face].material.uniforms.uAlbedo;
    const old = u.value;
    u.value = t;
    old.dispose();
  });
}

function setZoom(z) {
  if (S.flipping) return;
  Z.zT = THREE.MathUtils.clamp(z, Z.min, Z.max);
  clampPan();
}
// millimetres on the card per CSS pixel at a zoom level
function mmPerPx(z) {
  return (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2) * (camDistBase - TOP)) / z / innerHeight;
}

function setTilt(x, y) {
  S.tx = THREE.MathUtils.clamp((x / innerWidth) * 2 - 1, -1, 1);
  S.ty = THREE.MathUtils.clamp((y / innerHeight) * 2 - 1, -1, 1);
  S.lastMove = performance.now();
}

// ---- turning the card over is entirely in the hand: it tips toward wherever a
// swipe (or a mouse drag) goes, and how far it has turned follows the finger,
// all the way over. Let go and it settles onto the side it leans toward. A turn
// about a slanted axis would land the card turned in its own plane, so past
// upright it straightens itself as it goes over, and the writing lands upright.
const F = { phase: 'rest', wx: 1, wy: 0, theta: 0, from: 0, to: 0, t0: 0, dur: 0, rep: 'y', twist: 0 };
const AX = { x: new THREE.Vector3(1, 0, 0), y: new THREE.Vector3(0, 1, 0), z: new THREE.Vector3(0, 0, 1) };
const qStart = new THREE.Quaternion();          // resting orientation of the face that is up
const halfTurn = (a) => new THREE.Quaternion().setFromAxisAngle(AX[a], Math.PI);
const TWIST_FROM = Math.PI * 0.45;              // the straightening happens past this
const wrapPi = (a) => Math.atan2(Math.sin(a), Math.cos(a));

// The back can lie as a half turn about x or about y. The two differ by a half
// turn in the card's own plane, so the back's painting is turned with it:
// switching between them changes nothing that can be seen.
function holdBackAs(a) {
  F.rep = a;
  faceMesh[1].material.uniforms.uUvRot.value = a === 'x' ? 1 : 0;
  if (S.face === 1) qStart.copy(halfTurn(a));
}

// A half turn about an axis at angle a equals Rz(2a) after a half turn about x.
// While the face to be revealed is still out of sight, choose how the back is
// held (x: 0, y: PI) so the straightening twist is the smallest; after that,
// keep the twist continuous as the finger moves.
function updateTwist(free) {
  const a = Math.atan2(F.wx, -F.wy);             // turning axis = z cross w
  if (free || F.theta < TWIST_FROM) {
    const tx = wrapPi(-2 * a), ty = wrapPi(Math.PI - 2 * a);
    const rep = Math.abs(tx) <= Math.abs(ty) ? 'x' : 'y';
    if (rep !== F.rep) holdBackAs(rep);
    F.twist = rep === 'x' ? tx : ty;
  } else {
    const c = F.rep === 'x' ? 0 : Math.PI;
    F.twist += wrapPi(c - 2 * a - F.twist);
  }
}

function beginTurn(wx, wy) {
  if (S.face === 0) qStart.identity();
  F.wx = wx; F.wy = wy;
  F.theta = 0; F.phase = 'drag';
  updateTwist(true);
  S.flipping = true;
  S.lastMove = performance.now();
  // pull the camera back so the whole card is seen turning over
  Z.zT = 1; Z.xT = 0; Z.yT = 0;
}
// let go: settle onto the side the card leans toward
function settleTurn(over, dur) {
  F.phase = 'settle';
  F.from = F.theta;
  F.to = over ? Math.PI : 0;
  F.t0 = performance.now();
  F.dur = dur ?? (REDUCED ? 0.25 : 0.3 + 0.45 * Math.abs(F.to - F.from) / Math.PI);
}
function endTurn() {
  if (F.to > 0) {
    S.face = 1 - S.face;
    if (S.face === 0) qStart.identity(); else qStart.copy(halfTurn(F.rep));
    if (S.face === 1 && saveBtn && saveBtn.hidden && !saveBtn.dataset.asked) {
      saveBtn.dataset.asked = '1';
      saveReady.then((how) => {
        if (!how) return;
        saveBtn.hidden = false;
        requestAnimationFrame(() => saveBtn.classList.add('show'));
      });
    }
  }
  S.settleV = F.to > 0 ? -0.9 : -0.4;
  F.theta = 0; F.twist = 0; F.phase = 'rest';
  S.flipping = false;
}
// keyboard and tests: turn the card over toward a direction (x right, y away)
function flipBy(wx = 1, wy = 0) {
  if (F.phase !== 'rest' || U.uReveal.value < 1) return;
  const l = Math.hypot(wx, wy) || 1;
  beginTurn(wx / l, wy / l);
  settleTurn(true, REDUCED ? 0.6 : 1.2);
}
// finger travel -> how far the card has turned (a full turn over takes 0.6 of the screen)
function dragTurn(dist) {
  const D = 0.6 * Math.min(innerWidth, innerHeight);
  F.theta = THREE.MathUtils.clamp(dist / D, 0, 1) * Math.PI;
  updateTwist(false);
}

// ---- pointers: the mouse leans the card (and steers the view when zoomed);
// a drag or swipe turns it over; zoomed in, one finger pans; two fingers zoom
const touches = new Map();
let gesture = null;
let pinch = null;

canvas.addEventListener('pointerdown', (e) => {
  S.mouse = e.pointerType === 'mouse';
  if (S.mouse && e.button !== 0) return;
  canvas.setPointerCapture?.(e.pointerId);
  const now = performance.now();
  if (!S.mouse) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (touches.size >= 2) {
    const [a, b] = [...touches.values()];
    pinch = {
      d0: Math.hypot(a.x - b.x, a.y - b.y) || 1, z0: Z.zT, x0: Z.xT, y0: Z.yT,
      mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2,
    };
    if (gesture) {
      gesture.multi = true;
      if (F.phase === 'drag') settleTurn(F.theta > Math.PI / 2);
    }
    return;
  }
  gesture = {
    x: e.clientX, y: e.clientY, multi: false, turning: false,
    last: { x: e.clientX, y: e.clientY, t: now },
    pan: !S.mouse && Z.zT > 1.03,
  };
});

addEventListener('pointermove', (e) => {
  if (e.pointerType === 'mouse') {
    S.mouse = true;
    setTilt(e.clientX, e.clientY);
    if (!gesture) return;
  } else {
    if (!touches.has(e.pointerId)) return;
    touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
  }
  if (pinch && touches.size >= 2) {
    const [a, b] = [...touches.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
    const z = THREE.MathUtils.clamp(pinch.z0 * (d / pinch.d0), Z.min, Z.max);
    // keep the spot between the fingers under the fingers while zooming
    const cx = innerWidth / 2, cy = innerHeight / 2;
    const s0 = mmPerPx(pinch.z0), s1 = mmPerPx(z);
    if (!S.flipping) {
      Z.zT = z;
      Z.xT = pinch.x0 + (pinch.mx - cx) * s0 - (mx - cx) * s1;
      Z.yT = pinch.y0 - (pinch.my - cy) * s0 + (my - cy) * s1;
      clampPan();
    }
    return;
  }
  if (!gesture || gesture.multi) return;
  const ddx = e.clientX - gesture.last.x, ddy = e.clientY - gesture.last.y;
  gesture.last = { x: e.clientX, y: e.clientY, t: performance.now() };
  if (gesture.pan) {
    const k = mmPerPx(Z.z);
    Z.xT -= ddx * k;
    Z.yT += ddy * k;
    clampPan();
    return;
  }
  const dx = e.clientX - gesture.x, dy = e.clientY - gesture.y;
  const dist = Math.hypot(dx, dy);
  if (!gesture.turning) {
    if (dist < 10 || F.phase !== 'rest' || U.uReveal.value < 1) return;
    gesture.turning = true;
    beginTurn(dx / dist, -dy / dist);
  }
  if (F.phase !== 'drag') return;
  // the card tips toward the finger, whichever way it goes (screen down = toward the viewer)
  F.wx = dx / dist; F.wy = -dy / dist;
  dragTurn(dist);
});

function endPointer(e) {
  if (touches.has(e.pointerId)) {
    touches.delete(e.pointerId);
    if (touches.size < 2) pinch = null;
    if (touches.size === 1 && gesture) {
      const [p] = [...touches.values()];
      gesture.last = { x: p.x, y: p.y, t: performance.now() };
    }
  }
  if (!gesture || touches.size > 0) return;
  gesture = null;
  askMotion();
  // let go: it settles onto whichever side it leans toward
  if (F.phase === 'drag') settleTurn(F.theta > Math.PI / 2);
}
addEventListener('pointerup', endPointer);
addEventListener('pointercancel', endPointer);

addEventListener('wheel', (e) => {
  e.preventDefault();
  // trackpad pinches arrive as ctrl+wheel with small steps
  const k = e.ctrlKey ? 0.012 : 0.0016;
  const dy = e.deltaMode === 1 ? e.deltaY * 16 : e.deltaY;
  setZoom(Z.zT * Math.exp(-dy * k));
}, { passive: false });
// Safari: trackpad pinch on the Mac, and page zoom on iOS (which we keep off)
let gz = 1;
addEventListener('gesturestart', (e) => { e.preventDefault(); gz = Z.zT; });
addEventListener('gesturechange', (e) => { e.preventDefault(); if (!coarse) setZoom(gz * e.scale); });
addEventListener('gestureend', (e) => e.preventDefault());

canvas.addEventListener('keydown', (e) => {
  const turns = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, 1], ArrowDown: [0, -1], Enter: [1, 0], ' ': [1, 0] };
  if (turns[e.key]) { e.preventDefault(); flipBy(...turns[e.key]); }
  else if (e.key === '+' || e.key === '=') setZoom(Z.zT * 1.25);
  else if (e.key === '-') setZoom(Z.zT / 1.25);
  else if (e.key === '0') setZoom(1);
});

// ---- gyroscope: the phone's tilt leans the card. Readings are used as soon
// as they arrive; where the browser wants permission (iOS), the first touch asks
const DOE = window.DeviceOrientationEvent;
const needsMotionAsk = typeof DOE?.requestPermission === 'function' && navigator.maxTouchPoints > 0;
let gyroOn = false;
function startGyro() {
  if (gyroOn) return;
  gyroOn = true;
  addEventListener('deviceorientation', (e) => {
    if (e.beta == null || e.gamma == null) return;
    const ang = (screen.orientation && screen.orientation.angle) ?? window.orientation ?? 0;
    let x = e.gamma, y = e.beta;
    if (ang === 90) { x = e.beta; y = -e.gamma; }
    else if (ang === -90 || ang === 270) { x = -e.beta; y = e.gamma; }
    else if (ang === 180) { x = -e.gamma; y = -e.beta; }
    if (!S.gyro) S.gyro = { x0: x, y0: y };
    S.gyro.x = x; S.gyro.y = y;
  });
}
if (DOE) startGyro();   // desktops simply never send readings
// a touch release is the gesture iOS most reliably accepts for the permission dialog
addEventListener('touchend', () => askMotion(), { passive: true });
function askMotion() {
  if (!needsMotionAsk || S.gyroAsked) return;
  S.gyroAsked = true;
  DOE.requestPermission().catch(() => {});
}

// ---- save: a single-file copy of the card that opens anywhere. On claude.ai
// only members of the owner's organization may download, so the button is
// offered only where a save can really happen
const SAVE_NAME = '孙轶伟与赵欣宇-新婚贺卡.html';
const saveReady = (async () => {
  if (KEEP || !saveBtn) return null;
  if (!window.claude?.use) return 'link';          // an ordinary web page: a normal download
  try { return (await window.claude.use('downloads')) ? 'host' : null; } catch { return null; }
})();
function setSaveLabel(t) { saveBtn.querySelector('span').textContent = t; }
saveBtn?.addEventListener('click', async (e) => {
  e.stopPropagation();
  if (saveBtn.disabled) return;
  saveBtn.disabled = true;
  setSaveLabel('准备中…');
  try {
    const blob = await (await fetch('keepsake.html')).blob();
    const dl = (await saveReady) === 'host' ? await window.claude.use('downloads') : null;
    if (dl) {
      await dl.save({ filename: SAVE_NAME, data: blob });
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = SAVE_NAME;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 10000);
    }
    setSaveLabel('已保存');
    setTimeout(() => setSaveLabel('保存贺卡'), 2600);
  } catch (err) {
    setSaveLabel(err && err.code === 'declined' ? '保存贺卡' : '暂时无法保存');
    if (err && err.code !== 'declined') setTimeout(() => setSaveLabel('保存贺卡'), 2600);
  }
  saveBtn.disabled = false;
});
saveBtn?.addEventListener('pointerdown', (e) => e.stopPropagation());

// ---------------------------------------------------------------------------
// layout

const camTarget = new THREE.Vector3(0, 0, 0);
let camDistBase = 600;
function resize() {
  const w = innerWidth, h = innerHeight;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  const portrait = h > w;
  const fill = portrait ? 0.9 : Math.min(0.62, 0.84 * (h / w) * (CARD_W / CARD_H));
  const vfov = THREE.MathUtils.degToRad(camera.fov);
  const visW = CARD_W / fill;
  const visH = visW / camera.aspect;
  camDistBase = (visH / 2) / Math.tan(vfov / 2) + TOP;
  camera.updateProjectionMatrix();
  renderer.getDrawingBufferSize(U.uRes.value);
  U.uDustScale.value = renderer.getPixelRatio() * (h / 900);
}
addEventListener('resize', resize);
resize();

// ---------------------------------------------------------------------------
// loop

const clock = { last: performance.now(), elapsedTime: 0,
  getDelta() { const n = performance.now(); const d = (n - this.last) / 1000; this.last = n; this.elapsedTime += Math.min(d, 0.1); return d; } };
const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const eTmp = new THREE.Euler();
const qFlip = new THREE.Quaternion(), qLean = new THREE.Quaternion(), qTwist = new THREE.Quaternion();
const vUp = new THREE.Vector3(), vAxis = new THREE.Vector3(), vTmp = new THREE.Vector3();
const corners = [];
for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-THICK, TOP]) corners.push(new THREE.Vector3(x * CARD_W / 2, y * CARD_H / 2, z));
function lowestZ(q) {
  let m = Infinity;
  for (const c of corners) m = Math.min(m, vTmp.copy(c).applyQuaternion(q).z);
  return m;
}

let drawFace = -1;
function orderSheets(faceUp) {
  if (faceUp === drawFace) return;
  drawFace = faceUp;
  // nearest paper first: the depth test then rejects everything it covers
  for (const [m, z] of sheets) m.renderOrder = faceUp ? -z : z;
}

// opening timeline: shadows fade onto the paper as soon as the leaf texture is
// in; the colour bloom starts once every painting is on the GPU (and the
// shadows have had a moment)
const intro = { shadeT0: -1, t0: -1, dur: REDUCED ? 1.4 : 4.4, shadeDur: REDUCED ? 0.6 : 1.8, minShade: REDUCED ? 0.6 : 2.2 };
const smooth = (x) => x * x * (3 - 2 * x);

function frame() {
  const rawDt = clock.getDelta();
  const dt = Math.min(rawDt, 0.05);
  const t = clock.elapsedTime;
  U.uTime.value = REDUCED ? t * 0.3 : t;
  const now = performance.now();

  // opening: one texture to the GPU per frame, shadows onto the paper, then the bloom
  if (uploads.length) uploads.shift()();
  if (stream.gobo && intro.shadeT0 < 0) intro.shadeT0 = now;
  if (intro.shadeT0 >= 0 && U.uGhostShade.value < 1) {
    U.uGhostShade.value = smooth(Math.min(1, (now - intro.shadeT0) / 1000 / intro.shadeDur));
  }
  const loaded = stream.done === stream.total;
  if (loaded && !window.__card.ready) onLoaded();
  if (intro.t0 < 0 && loaded && !SHOT && intro.shadeT0 >= 0 && (now - intro.shadeT0) / 1000 > intro.minShade) {
    intro.t0 = now;
    $('#progress').classList.add('done');
  }
  let introK = U.uReveal.value;
  if (intro.t0 >= 0 && U.uReveal.value < 1) {
    introK = Math.min(1, (now - intro.t0) / 1000 / intro.dur);
    U.uReveal.value = introK;
    if (introK >= 1) { hint.classList.add('show'); S.lastMove = now; }   // stays aloft a while after
  }

  // input -> target tilt
  let gx = S.tx, gy = S.ty;
  let active = now - S.lastMove < 4000;
  const gyro = !!(S.gyro && S.gyro.x != null);
  if (gyro) {
    // ~9 degrees of tilt gives the full lean; the neutral pose follows the way
    // the phone is held only very slowly, so a held tilt keeps showing
    S.gyro.x0 += (S.gyro.x - S.gyro.x0) * Math.min(1, dt * 0.06);
    S.gyro.y0 += (S.gyro.y - S.gyro.y0) * Math.min(1, dt * 0.06);
    gx = THREE.MathUtils.clamp((S.gyro.x - S.gyro.x0) / 9, -1, 1);
    gy = THREE.MathUtils.clamp((S.gyro.y - S.gyro.y0) / 9, -1, 1);
    active = true;
  } else if (coarse && !REDUCED && !gesture && now - S.lastMove > 2500) {
    // no gyro: a slow sway so the layers still show their depth
    gx = Math.sin(t * 0.45) * 0.72; gy = Math.sin(t * 0.33 + 1.0) * 0.58;
    active = true;
  }
  S.px = THREE.MathUtils.damp(S.px, gx, 4.2, dt);
  S.py = THREE.MathUtils.damp(S.py, gy, 4.2, dt);
  const opening = intro.t0 >= 0 && U.uReveal.value < 1;
  S.liftT = (active || S.flipping || opening) && intro.t0 >= 0 ? 1 : 0;
  S.lift = THREE.MathUtils.damp(S.lift, S.liftT, S.liftT ? 3.0 : 1.6, dt);

  // zoom: with a mouse the view follows the pointer across the card
  if (S.mouse && Z.zT > 1.001 && !S.flipping) {
    const k = 1 - 1 / Z.zT;
    Z.xT = S.px * (CARD_W / 2 + 6) * k;
    Z.yT = -S.py * (CARD_H / 2 + 6) * k;
  }
  if (Z.zT > 1.5 && !S.flipping) sharpen(S.face);
  Z.z = THREE.MathUtils.damp(Z.z, Z.zT, S.flipping ? 4.5 : 7, dt);
  Z.x = THREE.MathUtils.damp(Z.x, Z.xT, S.flipping ? 4.5 : 7, dt);
  Z.y = THREE.MathUtils.damp(Z.y, Z.yT, S.flipping ? 4.5 : 7, dt);
  const zk = (Z.z - 1) / (Z.max - 1);

  // turning over: after letting go the card settles; from rest (keyboard) it eases both ways
  if (F.phase === 'settle') {
    const k = Math.min(1, (now - F.t0) / 1000 / F.dur);
    const e = F.from < 0.05 && F.to > 0 ? ease(k) : 1 - Math.pow(1 - k, 3);
    F.theta = F.from + (F.to - F.from) * e;
    if (k >= 1) endTurn();
  }
  const turnS = Math.sin(F.theta);
  const twistK = smooth(THREE.MathUtils.clamp((F.theta - TWIST_FROM) / (Math.PI - TWIST_FROM), 0, 1));
  // a light paper card lands with a tiny bounce
  S.settleV += (-S.settle * 90 - S.settleV * 9) * dt;
  S.settle += S.settleV * dt * 10;

  // zoomed in, the card holds steadier so the details can be read
  const maxT = (gyro ? 0.21 : 0.13) * S.lift * (1 - 0.6 * zk);
  S.rx = -S.py * maxT;
  S.ry = S.px * maxT * 1.15;
  // orientation: lean (pointer / gyro) * straightening twist * tip about the swipe axis * resting face
  vAxis.set(-F.wy, F.wx, 0);
  qFlip.setFromAxisAngle(vAxis, F.theta).multiply(qStart);
  qTwist.setFromAxisAngle(AX.z, F.twist * twistK);
  qFlip.premultiply(qTwist);
  qLean.setFromEuler(eTmp.set(S.rx, S.ry, 0, 'XYZ'));
  card.quaternion.setFromAxisAngle(AX.z, -0.03).multiply(qLean).multiply(qFlip);
  // height: the lowest corner of the card (with its stack of sheets) just clears the desk
  const hover = 21 * S.lift + (REDUCED ? 0 : Math.sin(t * 1.1) * 0.7 * S.lift);
  card.position.set(0, 0, 0.5 - lowestZ(card.quaternion) + hover + 8 * turnS + S.settle);
  card.updateMatrixWorld(true);
  orderSheets(vUp.set(0, 0, 1).applyQuaternion(qFlip).z > 0);
  U.uCardInv.value.copy(card.matrixWorld).invert();
  U.uCardRot.value.setFromMatrix4(card.matrixWorld);
  U.uCardInvRot.value.copy(U.uCardRot.value).transpose();

  // camera: frames the card at any height, leans with the pointer, and moves
  // in for a closer look; the opening drifts in from a little further away
  camTarget.x = Z.x;
  camTarget.y = Z.y;
  camTarget.z = THREE.MathUtils.damp(camTarget.z, card.position.z * 0.85, 3.0, dt);
  const dolly = 1 + 0.1 * (1 - ease(introK));
  const camDist = (camDistBase - TOP) / Z.z * dolly + TOP;
  const tilt = THREE.MathUtils.degToRad(11 + S.py * (gyro ? 5.0 : 3.0) * (1 - 0.5 * zk) - 4 * zk);
  const yaw = THREE.MathUtils.degToRad(-S.px * (gyro ? 7.0 : 4.0) * (1 - 0.5 * zk));
  camera.position.set(
    camTarget.x + Math.sin(yaw) * camDist * Math.cos(tilt),
    camTarget.y - Math.sin(tilt) * camDist,
    camTarget.z + Math.cos(tilt) * Math.cos(yaw) * camDist,
  );
  camera.lookAt(camTarget);
  camera.updateMatrixWorld();
  U.uInvViewProj.value.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse).invert();

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

// hooks for automated captures (?shot skips the opening)
const params = new URLSearchParams(location.search);
const SHOT = params.has('shot');
window.__card = {
  flip: flipBy,
  async fps(ms = 2000) {
    let n = 0; const t0 = performance.now();
    await new Promise((r) => { const f = () => { n++; if (performance.now() - t0 < ms) requestAnimationFrame(f); else r(); }; requestAnimationFrame(f); });
    return (n * 1000) / (performance.now() - t0);
  },
  pointer(x, y) { S.tx = x; S.ty = y; S.lastMove = performance.now() + 1e9; },
  zoom(z, x = 0, y = 0) { Z.zT = z; Z.xT = x; Z.yT = y; S.mouse = false; },
  reveal(v) { intro.t0 = -1; U.uReveal.value = v; },
  gpuTime(k = 20) {
    const gl = renderer.getContext(); const px = new Uint8Array(4);
    renderer.render(scene, camera); gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t0 = performance.now();
    for (let i = 0; i < k; i++) renderer.render(scene, camera);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return (performance.now() - t0) / k;
  },
  state: S,
  turn: F,
  ready: false,
};

function onLoaded() {
  window.__card.ready = true;
  if (SHOT) {
    U.uGhostShade.value = 1;
    U.uReveal.value = 1;
    $('#progress').classList.add('done');
    hint.classList.add('show');
  }
}

// compile every program while the page still shows plain paper, then draw;
// the canvas only becomes visible once it has drawn that same paper
hint.textContent = coarse ? '滑动翻面 · 双指缩放' : '拖动翻面 · 滚轮缩放';
try { await renderer.compileAsync(scene, camera); } catch (e) { renderer.compile(scene, camera); }
requestAnimationFrame(frame);
requestAnimationFrame(() => requestAnimationFrame(() => canvas.classList.add('live')));
