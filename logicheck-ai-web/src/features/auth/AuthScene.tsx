/* ============================================================
   登录页背景场景层（纯 SVG + CSS 动效，无图片素材）
   ------------------------------------------------------------
   结构：
   - .scene-field：正方形构图框（地球 / 轨道 / 航线共用）
   - 数字地球：经纬网缓慢自转 + 陆块剪影 + 边缘辉光 + 整体轻微漂浮
   - 环绕轨道：倾斜虚线椭圆 + 航点标记（飞机 / 定位 / 盾牌 / 核验 / 单证）
   - 国际物流航线：流动虚线 + 沿线移动光点
   - 货轮与港口剪影：贴底分层 + 水面涟漪
   - 柔和背景粒子：少量缓慢漂移
   所有动效走 CSS animation，可被 prefers-reduced-motion 整体关闭。
   ============================================================ */

/** 构图坐标系（与 .scene-field 的 viewBox 一致） */
const VB = 700
const CX = 350
const CY = 350
const R = 168
/** 环绕轨道（倾斜椭圆） */
const ORBIT_RX = 300
const ORBIT_RY = 372
const ORBIT_ROT = -16

/** 经线（投影椭圆） */
const MERIDIANS = [0, 26, 52, 78, 104, 130, 154].map((deg) => ({
  rx: Math.abs(Math.cos((deg * Math.PI) / 180)) * R,
  key: `m${deg}`,
}))

/** 纬线（水平弦） */
const PARALLELS = [-62, -34, -8, 18, 44, 68].map((deg) => {
  const rad = (deg * Math.PI) / 180
  return {
    y: CY - Math.sin(rad) * R,
    half: Math.cos(rad) * R,
    key: `p${deg}`,
  }
})

/** 球面港口节点 */
const PORTS = [
  { x: CX + 68, y: CY - 82, key: 'sh' },
  { x: CX + 2, y: CY - 118, key: 'rt' },
  { x: CX - 100, y: CY - 62, key: 'la' },
  { x: CX + 88, y: CY + 22, key: 'sg' },
  { x: CX - 50, y: CY + 48, key: 'br' },
]

/** 国际物流航线：起点 → 终点（球外弧线） */
const ROUTES = [
  { from: PORTS[0], to: PORTS[1], lift: 104, dur: 11 },
  { from: PORTS[1], to: PORTS[2], lift: 96, dur: 13 },
  { from: PORTS[0], to: PORTS[3], lift: 86, dur: 9.5 },
  { from: PORTS[4], to: PORTS[1], lift: 82, dur: 15 },
]

/** 环绕轨道上的航点标记（角度制，0 = 正右方） */
const ORBIT_NODES = [
  { deg: -68, kind: 'plane' },
  { deg: -14, kind: 'pin' },
  { deg: 34, kind: 'shield' },
  { deg: 96, kind: 'check' },
  { deg: 152, kind: 'file' },
  { deg: 210, kind: 'pin' },
]

/** 背景粒子：位置与节奏固定，保证每次渲染一致 */
const PARTICLES = [
  { x: 4, y: 22, s: 3, d: 19, delay: 0 },
  { x: 11, y: 63, s: 2, d: 23, delay: 2.4 },
  { x: 17, y: 34, s: 4, d: 21, delay: 5.1 },
  { x: 24, y: 78, s: 2, d: 26, delay: 1.2 },
  { x: 31, y: 12, s: 3, d: 20, delay: 7.6 },
  { x: 37, y: 49, s: 2, d: 24, delay: 3.3 },
  { x: 43, y: 86, s: 3, d: 22, delay: 9.4 },
  { x: 49, y: 26, s: 2, d: 28, delay: 4.8 },
  { x: 56, y: 60, s: 4, d: 20.5, delay: 11.2 },
  { x: 63, y: 38, s: 2, d: 25, delay: 6.5 },
  { x: 70, y: 72, s: 3, d: 23.5, delay: 13.1 },
  { x: 8, y: 90, s: 2, d: 27, delay: 8.8 },
  { x: 41, y: 95, s: 3, d: 21.5, delay: 14.4 },
  { x: 68, y: 8, s: 2, d: 24.5, delay: 10.7 },
]

/** 航点内部的小符号（描边风格） */
function OrbitGlyph({ kind }: { kind: string }) {
  if (kind === 'plane') {
    return <path d="M-8 0h12l4-4v8l-4-4h-3l4 5h-2l-3-5h-2l-1 5h-2l3-5h-4l-3 4v-8z" />
  }
  if (kind === 'shield') {
    return <path d="M0-8l7 2.5v5C7 4 3 6.5 0 8c-3-1.5-7-4-7-8.5v-5z" />
  }
  if (kind === 'check') {
    return <path d="M-6 0l4.5 4.5L7-8" />
  }
  if (kind === 'file') {
    return <path d="M-5.5-8h7l4 4v12h-11zM1.5-8v4h4M-2.5 1h6M-2.5 4.5h6" />
  }
  return <path d="M0-9c-3.2 0-5.5 2.3-5.5 5.5C-5.5.5 0 8 0 8s5.5-7.5 5.5-11.5C5.5-6.7 3.2-9 0-9zM0-1.5a2 2 0 100-4 2 2 0 000 4z" />
}

/** 轨道椭圆上的点（含倾斜旋转） */
function orbitPoint(deg: number) {
  const t = (deg * Math.PI) / 180
  const dx = ORBIT_RX * Math.cos(t)
  const dy = ORBIT_RY * Math.sin(t)
  const rot = (ORBIT_ROT * Math.PI) / 180
  return {
    x: CX + dx * Math.cos(rot) - dy * Math.sin(rot),
    y: CY + dx * Math.sin(rot) + dy * Math.cos(rot),
  }
}

export function AuthScene() {
  return (
    <div className="auth-scene" aria-hidden="true">
      {/* 网格纹理背景 */}
      <div className="scene-mesh" />

      {/* 背景粒子 */}
      <div className="scene-particles">
        {PARTICLES.map((p) => (
          <span
            key={`${p.x}-${p.y}`}
            className="scene-particle"
            style={{
              left: `${p.x}%`,
              top: `${p.y}%`,
              width: p.s,
              height: p.s,
              animationDuration: `${p.d}s`,
              animationDelay: `${p.delay}s`,
            }}
          />
        ))}
      </div>

      {/* 构图框：地球 + 轨道 + 航线共用同一坐标系 */}
      <div className="scene-field">
        {/* 地球外围大范围柔和光晕 */}
        <div className="scene-glow" />

        <svg className="scene-canvas" viewBox={`0 0 ${VB} ${VB}`} role="presentation">
          <defs>
            <radialGradient id="globeFill" cx="36%" cy="28%">
              <stop offset="0%" stopColor="var(--scene-globe-hi)" />
              <stop offset="100%" stopColor="var(--scene-globe-lo)" />
            </radialGradient>
            <radialGradient id="globeHalo" cx="50%" cy="50%">
              <stop offset="46%" stopColor="var(--scene-halo)" stopOpacity="0" />
              <stop offset="80%" stopColor="var(--scene-halo)" stopOpacity="0.26" />
              <stop offset="100%" stopColor="var(--scene-halo)" stopOpacity="0" />
            </radialGradient>
            <clipPath id="globeClip">
              <circle cx={CX} cy={CY} r={R} />
            </clipPath>
          </defs>

          {/* 环绕轨道（倾斜虚线椭圆） */}
          <ellipse
            className="scene-orbit"
            cx={CX}
            cy={CY}
            rx={ORBIT_RX}
            ry={ORBIT_RY}
            transform={`rotate(${ORBIT_ROT} ${CX} ${CY})`}
          />

          {/* 数字地球（整体轻微漂浮 + 内部经纬网自转） */}
          <g className="scene-globe">
            <circle className="scene-globe-halo" cx={CX} cy={CY} r={R + 82} fill="url(#globeHalo)" />

            <circle className="scene-globe-body" cx={CX} cy={CY} r={R} fill="url(#globeFill)" />

            <g clipPath="url(#globeClip)">
              {/* 陆块剪影（装饰性抽象轮廓，不对应真实地理） */}
              <g className="scene-globe-land">
                <path d="M296 276c26-16 62-22 84-6 14 10 6 22 22 28 12 5 4 16-8 20-18 6-24 18-40 22-20 5-40-6-52-20-12-14-22-32-6-44z" />
                <path d="M400 332c18-4 30 8 26 22-4 13-22 16-34 10-10-5-10-28 8-32z" />
                <path d="M250 368c14-10 34-6 42 8 6 12-6 22-18 26-16 5-34-2-36-16-1-8 6-14 12-18z" />
                <path d="M362 420c22-8 44 2 48 18 3 12-12 20-28 18-14-2-28-12-30-24-1-6 4-10 10-12z" />
                <path d="M262 232c10-6 22-4 26 6 3 9-4 15-13 14-8-1-19-14-13-20z" />
              </g>

              {/* 经纬网（缓慢自转） */}
              <g className="scene-globe-rotor">
                {MERIDIANS.map((m) => (
                  <ellipse
                    key={m.key}
                    className="scene-grid-line"
                    cx={CX}
                    cy={CY}
                    rx={m.rx}
                    ry={R}
                  />
                ))}
                {PARALLELS.map((p) => (
                  <line
                    key={p.key}
                    className="scene-grid-line"
                    x1={CX - p.half}
                    y1={p.y}
                    x2={CX + p.half}
                    y2={p.y}
                  />
                ))}
              </g>

              {/* 节点层（反向慢速自转，形成层次） */}
              <g className="scene-globe-orbit">
                {PORTS.map((p) => (
                  <g key={p.key}>
                    <circle className="scene-node-halo" cx={p.x} cy={p.y} r="8" />
                    <circle className="scene-node" cx={p.x} cy={p.y} r="3" />
                  </g>
                ))}
              </g>
            </g>

            {/* 球体边缘 */}
            <circle className="scene-globe-edge" cx={CX} cy={CY} r={R} />
          </g>

          {/* 国际物流航线 */}
          <g className="scene-routes">
            {ROUTES.map((r, i) => {
              const mx = (r.from.x + r.to.x) / 2
              const my = (r.from.y + r.to.y) / 2 - r.lift
              const d = `M ${r.from.x} ${r.from.y} Q ${mx} ${my} ${r.to.x} ${r.to.y}`
              return (
                <g key={`route-${i}`}>
                  <path className="scene-route" d={d} style={{ animationDuration: `${r.dur * 0.5}s` }} />
                  <circle className="scene-route-dot" r="3.4">
                    <animateMotion dur={`${r.dur}s`} repeatCount="indefinite" path={d} />
                  </circle>
                </g>
              )
            })}
          </g>

          {/* 环绕轨道上的航点标记 */}
          <g className="scene-orbit-nodes">
            {ORBIT_NODES.map((n, i) => {
              const p = orbitPoint(n.deg)
              return (
                <g
                  key={`${n.kind}-${i}`}
                  className="scene-orbit-node"
                  style={{ animationDelay: `${i * 0.9}s` }}
                >
                  <circle className="scene-orbit-node-halo" cx={p.x} cy={p.y} r="15" />
                  <circle className="scene-orbit-node-disc" cx={p.x} cy={p.y} r="11" />
                  <g transform={`translate(${p.x} ${p.y}) scale(0.6)`}>
                    <OrbitGlyph kind={n.kind} />
                  </g>
                </g>
              )
            })}
          </g>
        </svg>
      </div>

      {/* 货轮与港口剪影（贴底） */}
      <svg
        className="scene-harbor"
        viewBox="0 0 900 190"
        preserveAspectRatio="xMinYMax meet"
        role="presentation"
      >
        <g className="scene-harbor-shape">
          {/* 远处岸桥 */}
          <path d="M18 188v-52h6v-22h30v22h6v52zM24 114h30l-8-16H32z" />
          <path d="M96 188v-40h5v-16h22v16h5v40zM110 132l9-16h-18z" />
          <path d="M162 188v-60h5v-20h30v20h5v60zM168 108h34l-9-18h-16z" />
          <path d="M244 188v-34h5v-12h20v12h5v34z" />
          {/* 集装箱堆场 */}
          <path d="M300 188v-30h32v30zM336 188v-30h32v30zM300 156h32v-20h-32zM372 188v-30h32v30zM408 188v-30h28v30zM372 156h32v-18h-32z" />
          {/* 货轮 */}
          <path d="M470 172h196l-30 18H498z" />
          <path d="M520 172v-28h46v28zM574 172v-20h30v20zM636 172v-14h22v14z" />
          <path d="M546 144v-32h4v32zM600 144v-24h4v24z" />
          <path d="M530 112l8-12h12l-8 12zM606 120l7-11h11l-7 11z" />
          {/* 栈桥 */}
          <path d="M700 188v-56h6v56zM740 188v-56h6v56zM780 188v-56h6v56zM820 188v-56h6v56zM860 188v-56h6v56z" />
        </g>
        {/* 水面涟漪 */}
        <g className="scene-water">
          <path d="M0 187h900" />
          <path d="M40 180q44-9 88 0t88 0" />
          <path d="M380 182q50-10 100 0t100 0" />
          <path d="M660 178q42-8 84 0t84 0" />
        </g>
      </svg>
    </div>
  )
}
