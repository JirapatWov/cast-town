// Hand-drawn SVG illustrations (warm daylight palette) for building styles and onboarding.
import type { BuildingStyle, JobKind } from '../../../shared/protocol';

const defs = (id: string) => `
<defs>
  <linearGradient id="${id}-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8FB8DE" stop-opacity=".55"/><stop offset="1" stop-color="#F6D7B0" stop-opacity=".35"/></linearGradient>
  <linearGradient id="${id}-glass" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#BFE0F5"/><stop offset=".55" stop-color="#7EAFD6"/><stop offset="1" stop-color="#4F7FAE"/></linearGradient>
  <radialGradient id="${id}-glow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#FFE3A6"/><stop offset="1" stop-color="#F5B860"/></radialGradient>
  <linearGradient id="${id}-grass" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8DBA6E"/><stop offset="1" stop-color="#5E8F4C"/></linearGradient>
</defs>`;

const ground = (id: string) =>
  `<ellipse cx="80" cy="99" rx="74" ry="9" fill="url(#${id}-grass)"/><ellipse cx="80" cy="97" rx="60" ry="5" fill="#000" opacity=".12"/>`;

const tree = (x: number, y: number, s = 1, tone = '#6F9E58') =>
  `<g transform="translate(${x} ${y}) scale(${s})"><rect x="-1.6" y="-4" width="3.2" height="12" rx="1.2" fill="#7A5638"/><circle cx="0" cy="-10" r="9" fill="${tone}"/><circle cx="-4" cy="-13" r="5" fill="#8DBA6E" opacity=".75"/></g>`;

const SUN = (id: string) => `<circle cx="132" cy="22" r="11" fill="url(#${id}-glow)" opacity=".9"/>`;

const STYLES: Record<BuildingStyle, (id: string) => string> = {
  house: (id) => `
  <rect width="160" height="110" fill="url(#${id}-sky)"/>${SUN(id)}${ground(id)}
  ${tree(24, 92, 1.1)}${tree(140, 94, 0.85, '#5E8F4C')}
  <rect x="42" y="50" width="76" height="46" fill="#EFE7DA"/>
  <rect x="96" y="50" width="22" height="46" fill="#D9CBB7"/>
  <path d="M35 52 L80 20 L125 52 Z" fill="#8C5A45"/><path d="M80 20 L125 52 L118 52 L80 25 Z" fill="#6E4535"/>
  <rect x="51" y="58" width="15" height="13" rx="1.5" fill="url(#${id}-glow)"/><rect x="94" y="58" width="15" height="13" rx="1.5" fill="url(#${id}-glass)"/>
  <path d="M58.5 58v13M51 64.5h15" stroke="#EFE7DA" stroke-width="1.4"/>
  <rect x="51" y="78" width="22" height="13" rx="1.5" fill="url(#${id}-glass)"/>
  <rect x="85" y="76" width="12" height="20" rx="1.2" fill="#4A3B33"/><circle cx="94.5" cy="86.5" r=".9" fill="#F5C26B"/>
  <path d="M80 74 h22 l3 -3 h-28 z" fill="#6E4535"/>
  <rect x="78" y="96" width="26" height="2.6" fill="#CDBFAA"/>
  <circle cx="45" cy="95" r="3.5" fill="#E58E73"/><circle cx="111" cy="95" r="3" fill="#F2C35B"/>`,
  office: (id) => `
  <rect width="160" height="110" fill="url(#${id}-sky)"/>${SUN(id)}${ground(id)}
  ${tree(30, 94, 0.9)}${tree(132, 94, 0.95, '#5E8F4C')}
  <rect x="58" y="14" width="40" height="82" fill="url(#${id}-glass)"/>
  <rect x="86" y="14" width="12" height="82" fill="#3E6A95" opacity=".55"/>
  <g stroke="#E8F3FB" stroke-opacity=".55" stroke-width=".9">
    <path d="M58 24h40M58 34h40M58 44h40M58 54h40M58 64h40M58 74h40M58 84h40"/><path d="M68 14v82M78 14v82M88 14v82"/>
  </g>
  <rect x="60" y="45" width="7" height="8" fill="#FFD58A" opacity=".9"/><rect x="79" y="65" width="7" height="8" fill="#FFD58A" opacity=".85"/>
  <rect x="55" y="10" width="46" height="5" rx="1" fill="#D9D3CA"/>
  <rect x="98" y="58" width="30" height="38" fill="#E4DDD2"/><rect x="98" y="58" width="30" height="4" fill="#CFC6B9"/>
  <rect x="103" y="66" width="20" height="9" rx="1" fill="url(#${id}-glass)"/><rect x="103" y="80" width="20" height="9" rx="1" fill="url(#${id}-glass)"/>
  <rect x="71" y="84" width="14" height="12" fill="#2E3B48"/><path d="M78 84v12" stroke="#9CC7E6" stroke-width=".8"/>`,
  cottage: (id) => `
  <rect width="160" height="110" fill="url(#${id}-sky)"/>${SUN(id)}${ground(id)}
  ${tree(132, 94, 1.15, '#5E8F4C')}${tree(22, 95, 0.8)}
  <path d="M108 22 c-4 -6 4 -9 0 -15" stroke="#fff" stroke-opacity=".6" stroke-width="2.4" fill="none" stroke-linecap="round"/>
  <rect x="103" y="26" width="9" height="18" fill="#9A5A45"/>
  <rect x="48" y="56" width="64" height="40" fill="#B9694E"/>
  <g stroke="#9A5A45" stroke-width=".8" opacity=".75"><path d="M48 64h64M48 72h64M48 80h64M48 88h64"/></g>
  <path d="M40 58 L80 26 L120 58 Z" fill="#6B4A36"/><path d="M44 58 L80 30 L116 58" fill="none" stroke="#8C6248" stroke-width="2.2"/>
  <circle cx="80" cy="45" r="5" fill="url(#${id}-glow)" stroke="#5A3D2C" stroke-width="1.6"/>
  <rect x="56" y="66" width="13" height="12" rx="1" fill="url(#${id}-glow)" stroke="#F1E6D3" stroke-width="1.6"/>
  <rect x="91" y="66" width="13" height="12" rx="1" fill="url(#${id}-glow)" stroke="#F1E6D3" stroke-width="1.6"/>
  <path d="M74 96 v-14 a6 6 0 0 1 12 0 v14 z" fill="#4A3B33"/>
  <rect x="54" y="80" width="17" height="4" rx="1.5" fill="#6F9E58"/><circle cx="57" cy="80" r="2" fill="#E58E73"/><circle cx="62" cy="79.5" r="2" fill="#F2C35B"/><circle cx="67" cy="80" r="2" fill="#E58E73"/>`,
  studio: (id) => `
  <rect width="160" height="110" fill="url(#${id}-sky)"/>${SUN(id)}${ground(id)}
  ${tree(20, 94, 0.9)}
  <rect x="32" y="44" width="100" height="52" fill="#A85E46"/>
  <path d="M32 44 l20 -16 v16 l20 -16 v16 l20 -16 v16 l20 -16 v16 l20 -16 v16 z" fill="#4E5661"/>
  <path d="M52 28 v16 M72 28 v16 M92 28 v16 M112 28 v16" stroke="url(#${id}-glass)" stroke-width="3.5"/>
  <rect x="40" y="54" width="52" height="30" rx="1" fill="url(#${id}-glow)"/>
  <g stroke="#2F3237" stroke-width="1.6"><path d="M40 64h52M40 74h52M53 54v30M66 54v30M79 54v30"/><rect x="40" y="54" width="52" height="30" rx="1" fill="none"/></g>
  <rect x="102" y="58" width="22" height="38" fill="#2F3237"/><rect x="105" y="61" width="16" height="24" fill="url(#${id}-glass)"/>
  <rect x="32" y="92" width="100" height="4" fill="#7E4433"/>
  ${tree(146, 95, 0.7, '#5E8F4C')}`,
};

export function buildingIllustration(style: BuildingStyle): string {
  const id = `b-${style}`;
  return `<svg viewBox="0 0 160 110" class="illus" aria-hidden="true" focusable="false">${defs(id)}${STYLES[style](id)}</svg>`;
}

/** Onboarding illustrations: the town, a house that is a folder, people who are agents. */
export const ONBOARDING_ART: string[] = [
  // 1 — the town is your workspace
  `<svg viewBox="0 0 240 140" class="illus" aria-hidden="true" focusable="false">${defs('o1')}
    <rect width="240" height="140" fill="url(#o1-sky)"/><circle cx="196" cy="30" r="14" fill="url(#o1-glow)"/>
    <path d="M10 112 L120 70 L230 112 L120 138 Z" fill="url(#o1-grass)"/>
    <path d="M58 92 L176 125 M78 128 L184 86" stroke="#5B5F66" stroke-width="10" stroke-linecap="round" opacity=".85"/>
    <path d="M58 92 L176 125 M78 128 L184 86" stroke="#F4F1EC" stroke-width=".9" stroke-dasharray="4 4" opacity=".7"/>
    <g transform="translate(70 64)"><path d="M0 22 L16 14 L32 22 L32 40 L16 48 L0 40Z" fill="#EFE7DA"/><path d="M16 14 L32 22 L32 40 L16 48Z" fill="#D9CBB7"/><path d="M-2 22 L16 4 L34 22 L16 30Z" fill="#8C5A45"/><rect x="5" y="28" width="5" height="5" fill="#FFD58A"/></g>
    <g transform="translate(140 52)"><path d="M0 14 L14 7 L28 14 L28 52 L14 59 L0 52Z" fill="url(#o1-glass)"/><path d="M14 7 L28 14 L28 52 L14 59Z" fill="#3E6A95" opacity=".6"/><path d="M3 24h9M3 32h9M3 40h9" stroke="#E8F3FB" stroke-opacity=".6"/></g>
    <g transform="translate(108 92)"><path d="M0 14 L13 8 L26 14 L26 28 L13 34 L0 28Z" fill="#B9694E"/><path d="M13 8 L26 14 L26 28 L13 34Z" fill="#9A5A45"/><path d="M-2 14 L13 0 L28 14 L13 21Z" fill="#6B4A36"/></g>
    <g transform="translate(40 92)"><rect x="0" y="0" width="22" height="16" rx="2" fill="#F4F1EC" opacity=".85"/><path d="M4 5h14M4 10h9" stroke="#8C8279" stroke-width="1.6"/></g>
    ${tree(40, 86, 0.8)}${tree(192, 98, 0.9, '#5E8F4C')}${tree(128, 72, 0.6)}
  </svg>`,
  // 2 — a house is a project folder
  `<svg viewBox="0 0 240 140" class="illus" aria-hidden="true" focusable="false">${defs('o2')}
    <rect width="240" height="140" fill="url(#o2-sky)"/><circle cx="40" cy="30" r="12" fill="url(#o2-glow)"/>
    <ellipse cx="120" cy="124" rx="96" ry="10" fill="url(#o2-grass)"/>
    <path d="M62 52 h40 l8 -10 h68 a4 4 0 0 1 4 4 v74 h-124 z" fill="#E9B65C"/>
    <path d="M58 60 h126 a4 4 0 0 1 4 4 v56 h-134 v-56 a4 4 0 0 1 4 -4 z" fill="#F5C978"/>
    <rect x="146" y="30" width="9" height="20" fill="#6E4535"/><path d="M78 62 L121 26 L164 62 Z" fill="#8C5A45"/><path d="M121 26 L164 62 L150 62 L121 38 Z" fill="#6E4535"/>
    <rect x="76" y="74" width="22" height="18" rx="2" fill="url(#o2-glass)"/><rect x="144" y="74" width="22" height="18" rx="2" fill="url(#o2-glow)"/>
    <rect x="111" y="88" width="20" height="32" rx="2" fill="#4A3B33"/><circle cx="127" cy="104" r="1.4" fill="#F5C26B"/>
    <g transform="translate(145 98)"><rect x="0" y="0" width="64" height="18" rx="4" fill="#26231F"/><text x="32" y="12.5" text-anchor="middle" font-family="JetBrains Mono, monospace" font-size="8.5" fill="#F4F1EC">my-project/</text><rect x="30.5" y="18" width="3" height="10" fill="#5A4636"/></g>
  </svg>`,
  // 3 — a person is an agent
  `<svg viewBox="0 0 240 140" class="illus" aria-hidden="true" focusable="false">${defs('o3')}
    <rect width="240" height="140" fill="url(#o3-sky)"/>
    <rect x="0" y="104" width="240" height="36" fill="#C9A27C" opacity=".55"/>
    <rect x="128" y="78" width="70" height="5" rx="1.5" fill="#8A6446"/><rect x="132" y="83" width="4" height="25" fill="#7A5638"/><rect x="190" y="83" width="4" height="25" fill="#7A5638"/>
    <rect x="148" y="56" width="32" height="21" rx="2" fill="#26231F"/><rect x="151" y="59" width="26" height="15" rx="1" fill="#2E3B48"/>
    <path d="M154 63h12M154 67h18M154 71h9" stroke="#3FB37F" stroke-width="1.4"/><rect x="161" y="77" width="6" height="2" fill="#26231F"/>
    <g transform="translate(92 46)">
      <circle cx="0" cy="0" r="9" fill="#E8B796"/><path d="M-9 -2 a9 9 0 0 1 18 0 c-3 -6 -15 -6 -18 0z" fill="#3B2A22"/>
      <path d="M-13 14 a13 8 0 0 1 26 0 v24 h-26 z" fill="#D97757"/>
      <path d="M-13 38 h26 v22 h-10 v-12 h-6 v12 h-10z" fill="#4B4F57"/>
      <path d="M13 18 l14 10" stroke="#D97757" stroke-width="6" stroke-linecap="round"/><circle cx="28" cy="29" r="3" fill="#E8B796"/>
      <ellipse cx="0" cy="62" rx="17" ry="4" fill="none" stroke="#D97757" stroke-width="2" opacity=".8"/>
    </g>
    <g transform="translate(46 22)"><rect x="0" y="0" width="58" height="22" rx="11" fill="#F4F1EC"/><path d="M38 21 l6 7 l-1 -7z" fill="#F4F1EC"/><text x="29" y="14.5" text-anchor="middle" font-family="Inter, sans-serif" font-size="9" font-weight="600" fill="#26231F">On it!</text></g>
    <g transform="translate(36 84)" opacity=".9"><circle cx="0" cy="0" r="5" fill="#E2C2A6"/><path d="M-7 8 a7 5 0 0 1 14 0 v13 h-14z" fill="#10A37F"/><path d="M-7 21h14v12h-14z" fill="#4B4F57"/></g>
    <g transform="translate(214 86)" opacity=".9"><circle cx="0" cy="0" r="5" fill="#C99B7B"/><path d="M-7 8 a7 5 0 0 1 14 0 v13 h-14z" fill="#4D6BFE"/><path d="M-7 21h14v12h-14z" fill="#4B4F57"/></g>
  </svg>`,
];

// ── Job kinds: the room you'll get (new-job dialog cards). viewBox 160 × 96. ──
const kdefs = (id: string, top: string, bottom: string) => `
<defs>
  <linearGradient id="${id}-wall" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>
  <linearGradient id="${id}-desk" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#A97A58"/><stop offset=".12" stop-color="#8E6347"/><stop offset="1" stop-color="#6E4A35"/></linearGradient>
  <linearGradient id="${id}-sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#A9CFEA"/><stop offset="1" stop-color="#F6D7B0"/></linearGradient>
  <radialGradient id="${id}-glow" cx=".5" cy=".5" r=".5"><stop offset="0" stop-color="#FFE7B0" stop-opacity=".9"/><stop offset="1" stop-color="#FFD58A" stop-opacity="0"/></radialGradient>
  <linearGradient id="${id}-screen" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#16202C"/><stop offset="1" stop-color="#0D131B"/></linearGradient>
</defs>`;

const desk = (id: string, y: number) =>
  `<rect x="0" y="${y}" width="160" height="${96 - y}" fill="url(#${id}-desk)"/><rect x="0" y="${y}" width="160" height="1.4" fill="#C2946F" opacity=".8"/>`;

const steam = (x: number, y: number) =>
  `<path d="M${x} ${y} c-2.5 -3 2.5 -5 0 -8 M${x + 4} ${y - 1} c-2.5 -3 2.5 -5 0 -8" stroke="#fff" stroke-opacity=".55" stroke-width="1.3" fill="none" stroke-linecap="round"/>`;

const KIND_ART: Record<JobKind, (id: string) => string> = {
  general: (id) => `${kdefs(id, '#F4E6CF', '#E6CBA4')}
    <rect width="160" height="96" fill="url(#${id}-wall)"/>
    <rect x="16" y="10" width="44" height="40" rx="2" fill="#F8EEDD"/><rect x="19" y="13" width="38" height="34" rx="1" fill="url(#${id}-sky)"/>
    <circle cx="48" cy="22" r="5" fill="#FFE3A6"/><path d="M19 40 q10 -8 19 -2 t19 -3 v12 h-38z" fill="#8DBA6E" opacity=".8"/>
    <path d="M38 13v34M19 30h38" stroke="#F8EEDD" stroke-width="2"/>
    <g transform="translate(100 14) rotate(-4)"><rect width="13" height="13" rx="1" fill="#F5C26B"/><path d="M3 5h7M3 8h5" stroke="#9A6B2C" stroke-width=".9"/></g>
    <g transform="translate(116 12) rotate(5)"><rect width="13" height="13" rx="1" fill="#E58E73"/><path d="M3 5h7M3 8h4" stroke="#8A3F2C" stroke-width=".9"/></g>
    <g transform="translate(109 29) rotate(2)"><rect width="13" height="13" rx="1" fill="#A8CF8E"/><path d="M3 5h7M3 8h6" stroke="#4E7A3A" stroke-width=".9"/></g>
    <ellipse cx="114" cy="66" rx="30" ry="9" fill="url(#${id}-glow)"/>
    ${desk(id, 64)}
    <path d="M128 64 h12 M134 64 v-4 l-12 -16 l10 -10" stroke="#3B3530" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"/>
    <path d="M124 30 l15 3 l-6 11 z" fill="#F5C26B"/><path d="M127 40 l8 2" stroke="#FFE7B0" stroke-width="1.4"/>
    <rect x="66" y="56" width="34" height="9" rx="1" fill="#FBF6EC" transform="rotate(-3 83 60)"/>
    <path d="M70 59.5l1.5 1.5 3 -3M78 59h14" stroke="#3FB37F" stroke-width="1.1" fill="none" transform="rotate(-3 83 60)"/>
    <path d="M40 54 h12 v10 a3 3 0 0 1 -3 3 h-6 a3 3 0 0 1 -3 -3z" fill="#F4F1EC"/><path d="M52 57 a3 3 0 0 1 0 6" stroke="#F4F1EC" stroke-width="1.8" fill="none"/>${steam(44, 51)}
    <path d="M14 66 h12 l-2 10 h-8z" fill="#C8765A"/><path d="M20 66 c-6 -6 -6 -12 -2 -16 M20 66 c2 -8 6 -12 10 -12 M20 66 c-2 -6 -8 -8 -11 -7" stroke="#6F9E58" stroke-width="3" fill="none" stroke-linecap="round"/>`,
  code: (id) => `${kdefs(id, '#253246', '#1A2333')}
    <rect width="160" height="96" fill="url(#${id}-wall)"/>
    <ellipse cx="76" cy="36" rx="58" ry="32" fill="#6FB7E8" opacity=".14"/>
    <rect x="30" y="8" width="92" height="54" rx="3" fill="#0F141B" stroke="#3A4656" stroke-width="1.2"/>
    <rect x="34" y="12" width="84" height="46" rx="1.5" fill="url(#${id}-screen)"/>
    <g stroke-width="2.6" stroke-linecap="round">
      <path d="M39 18h10" stroke="#A58CF0"/><path d="M52 18h22" stroke="#6FB7E8"/>
      <path d="M44 24h14" stroke="#F5C26B"/><path d="M61 24h26" stroke="#E8E3DA" opacity=".7"/>
      <path d="M44 30h8" stroke="#E58E73"/><path d="M55 30h18" stroke="#8DBA6E"/>
      <path d="M49 36h24" stroke="#E8E3DA" opacity=".5"/><path d="M76 36h12" stroke="#6FB7E8"/>
      <path d="M44 42h16" stroke="#8DBA6E"/>
      <path d="M39 48h6" stroke="#A58CF0"/><path d="M48 48h3" stroke="#F5C26B"/>
    </g>
    <rect x="52" y="47" width="2" height="4" fill="#F4F1EC"><animate attributeName="opacity" values="1;0;1" dur="1.1s" repeatCount="indefinite"/></rect>
    <g transform="translate(110 22)"><rect width="40" height="28" rx="2.5" fill="#0B0F14" stroke="#33404F"/><circle cx="5" cy="4.5" r="1.2" fill="#E5484D"/><circle cx="9" cy="4.5" r="1.2" fill="#F5A524"/><circle cx="13" cy="4.5" r="1.2" fill="#3FB37F"/>
      <path d="M4 12h3M9 12h16M4 17h3M9 17h10M4 22h3" stroke-width="1.6" stroke-linecap="round" stroke="#3FB37F"/><path d="M9 22h5" stroke="#E8E3DA" stroke-width="1.6" opacity=".6"/></g>
    <rect x="70" y="62" width="12" height="6" fill="#2B333F"/><rect x="60" y="67" width="32" height="2.5" rx="1" fill="#39424F"/>
    ${desk(id, 69)}
    <g transform="translate(44 75)"><rect width="64" height="10" rx="2" fill="#2A303A"/><path d="M4 3.5h56M4 6.5h56" stroke="#4A5462" stroke-width="1.6" stroke-dasharray="3 1.6"/></g>
    <rect x="116" y="76" width="18" height="8" rx="4" fill="#3A4250"/>
    <path d="M128 60 h11 v11 a3 3 0 0 1 -3 3 h-5 a3 3 0 0 1 -3 -3z" fill="#6FB7E8"/><path d="M139 63 a3 3 0 0 1 0 6" stroke="#6FB7E8" stroke-width="1.8" fill="none"/>${steam(131, 57)}`,
  write: (id) => `${kdefs(id, '#F3DED2', '#E5BFA9')}
    <rect width="160" height="96" fill="url(#${id}-wall)"/>
    <ellipse cx="30" cy="16" rx="40" ry="26" fill="url(#${id}-glow)" opacity=".7"/>
    <g transform="translate(108 10)"><rect width="34" height="26" rx="1.5" fill="#8C6248"/><rect x="3" y="3" width="28" height="20" fill="url(#${id}-sky)"/><path d="M3 23 l9 -10 l6 6 l4 -4 l9 8z" fill="#7E9F6A"/><circle cx="24" cy="9" r="2.6" fill="#FFE3A6"/></g>
    ${desk(id, 62)}
    <path d="M34 52 L77 47 L77 74 L37 79 Z" fill="#FBF6EC"/><path d="M77 47 L120 52 L117 79 L77 74 Z" fill="#F4ECDD"/>
    <path d="M77 47 v27" stroke="#D9CBB7" stroke-width="1"/><path d="M34 52 L37 79 L77 74 L117 79 L120 52" stroke="#D9CBB7" stroke-width="1" fill="none"/>
    <g stroke="#8C7A6B" stroke-width="1" fill="none" stroke-linecap="round" opacity=".85">
      <path d="M41 57 c3 -1 6 1 9 0 s6 -1 9 0 s6 -1 12 -1"/><path d="M42 62 c3 -1 6 1 9 0 s6 -1 9 0 s5 0 10 -1"/><path d="M42 67 c3 -1 6 1 9 0 s6 -1 12 -1"/><path d="M43 72 c4 -1 8 0 14 -1"/>
      <path d="M83 54 c3 0 6 1 9 0 s6 0 12 1"/><path d="M83 59 c3 0 6 1 9 0 s6 0 13 1"/><path d="M83 64 c3 0 6 1 9 0 s4 0 8 1"/>
    </g>
    <path d="M100 64 L126 40" stroke="#2E2A33" stroke-width="4" stroke-linecap="round"/><path d="M126 40 l3 -3" stroke="#F5C26B" stroke-width="4" stroke-linecap="round"/><path d="M99.2 64.8 l-3 3.2" stroke="#C9A24D" stroke-width="1.6" stroke-linecap="round"/>
    <g transform="translate(122 62)"><rect x="2" y="-2" width="30" height="8" fill="#EDE3D2"/><rect x="0" y="1" width="30" height="8" fill="#F7F0E3"/><rect x="3" y="4" width="30" height="8" fill="#FBF6EC"/><path d="M7 7h20M7 9.5h14" stroke="#B7A897" stroke-width=".8"/></g>
    <ellipse cx="20" cy="74" rx="11" ry="3" fill="#EDE3D2"/><path d="M12 62 h16 v6 a6 6 0 0 1 -6 6 h-4 a6 6 0 0 1 -6 -6z" fill="#E58E73"/><path d="M28 64 a3 3 0 0 1 0 6" stroke="#E58E73" stroke-width="1.8" fill="none"/>${steam(18, 59)}`,
  research: (id) => `${kdefs(id, '#E6DFF4', '#CFC3EA')}
    <rect width="160" height="96" fill="url(#${id}-wall)"/>
    <g transform="translate(14 9)"><rect width="44" height="34" rx="2" fill="#C9A57E"/><rect x="4" y="4" width="36" height="26" fill="#FBF6EC"/>
      <path d="M8 26 h28" stroke="#B7A897" stroke-width=".8"/><rect x="10" y="17" width="5" height="9" fill="#A58CF0"/><rect x="17" y="12" width="5" height="14" fill="#6FB7E8"/><rect x="24" y="15" width="5" height="11" fill="#F5C26B"/><rect x="31" y="9" width="5" height="17" fill="#E58E73"/>
      <circle cx="40" cy="4" r="2" fill="#E5484D"/></g>
    <g transform="translate(70 12)" opacity=".9"><rect width="22" height="16" rx="1.5" fill="#FBF6EC" transform="rotate(6)"/><path d="M4 6h12M4 9.5h9" stroke="#8C7A6B" stroke-width=".9" transform="rotate(6)"/></g>
    ${desk(id, 66)}
    <path d="M116 64 h20" stroke="#8C6248" stroke-width="3" stroke-linecap="round"/><path d="M126 64 v-5" stroke="#8C6248" stroke-width="2.4"/>
    <path d="M113 40 a14 14 0 0 0 26 8" stroke="#8C6248" stroke-width="2" fill="none"/>
    <circle cx="126" cy="42" r="12" fill="#6FB7E8"/><path d="M118 36 c4 -2 6 2 9 0 s3 4 6 3 M116 46 c3 -1 5 2 8 1 s2 4 6 2" stroke="#8DBA6E" stroke-width="3.2" fill="none" stroke-linecap="round"/>
    <circle cx="121" cy="37" r="3.4" fill="#fff" opacity=".25"/>
    <g transform="translate(58 44)"><rect x="2" y="0" width="44" height="7" rx="1" fill="#A58CF0"/><rect x="2" y="5.5" width="44" height="1.5" fill="#F4F1EC" opacity=".7"/>
      <rect x="0" y="7" width="46" height="7" rx="1" fill="#8DBA6E"/><rect x="0" y="12.5" width="46" height="1.5" fill="#F4F1EC" opacity=".7"/>
      <rect x="3" y="14" width="42" height="8" rx="1" fill="#E58E73"/><rect x="3" y="20" width="42" height="1.6" fill="#F4F1EC" opacity=".7"/></g>
    <rect x="16" y="70" width="34" height="18" rx="1" fill="#FBF6EC" transform="rotate(-4 33 79)"/>
    <path d="M20 75h20M20 79h24M20 83h14" stroke="#B7A897" stroke-width="1" transform="rotate(-4 33 79)"/>
    <circle cx="38" cy="77" r="8" fill="#BFE0F5" fill-opacity=".45" stroke="#3A3240" stroke-width="2.6"/><path d="M44 83 l9 8" stroke="#3A3240" stroke-width="4" stroke-linecap="round"/>
    <circle cx="35" cy="74" r="2" fill="#fff" opacity=".6"/>`,
};

export function kindIllustration(kind: JobKind): string {
  const id = `k-${kind}`;
  return `<svg viewBox="0 0 160 96" class="illus" preserveAspectRatio="xMidYMid slice" aria-hidden="true" focusable="false">${KIND_ART[kind](id)}</svg>`;
}
