/*
 * The home screen: three doors. Topics is the one for learning a subject.
 *
 * Atlas is for exploring across subjects, Quiz tests the whole corpus by
 * cluster. The old per-dataset quiz tiles, GitHub token box and lane timeline
 * were removed in the 2026-11 cleanup; they are in git history if needed.
 */

export function renderHome(){
  const door = (fn, title, blurb, art, accent) => `
    <button onclick="${fn}()"
      class="group relative overflow-hidden text-left rounded-[2rem] p-10
             min-h-[440px] flex flex-col justify-end
             bg-white border border-zinc-200 shadow-sm
             hover:shadow-2xl hover:-translate-y-1 transition-all duration-300">

      <div class="absolute inset-0 opacity-[0.13] group-hover:opacity-25
                  group-hover:scale-110 transition-all duration-500">
        ${art}
      </div>

      <div class="absolute inset-x-0 top-0 h-1.5" style="background:${accent}"></div>

      <div class="relative">
        <div class="text-6xl font-bold tracking-tight mb-3">${title}</div>
        <div class="text-lg text-zinc-500 leading-snug max-w-sm">${blurb}</div>
        <div class="mt-7 inline-flex items-center gap-2 text-lg font-semibold">
          Open
          <span class="group-hover:translate-x-1 transition-transform">→</span>
        </div>
      </div>
    </button>
  `;

  /*
   * The artwork is inline SVG rather than an image so the page keeps its single
   * HTTP request and nothing can 404. Each one is a sketch of what the view
   * does: scattered points on a time axis for the atlas, a question mark built
   * out of the same dots for the quiz.
   */
  const atlasArt = `
    <svg viewBox="0 0 400 300" class="w-full h-full" preserveAspectRatio="xMidYMid slice">
      ${Array.from({ length: 130 }, (_, i) => {
        // A fixed pseudo-random scatter — deterministic, so the card does not
        // reshuffle on every render.
        const a = Math.sin(i * 12.9898) * 43758.5453;
        const b = Math.sin(i * 78.233) * 12345.6789;
        const x = Math.abs(a % 1) * 380 + 10;
        const y = Math.abs(b % 1) * 260 + 20;
        const r = 1.5 + Math.abs(a % 1) * 3.5;
        return `<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${r.toFixed(1)}" fill="#0f172a"/>`;
      }).join('')}
      ${[60, 120, 180, 240].map((y) =>
        `<line x1="0" y1="${y}" x2="400" y2="${y}" stroke="#0f172a" stroke-width="0.5"/>`).join('')}
    </svg>`;

  const quizArt = `
    <svg viewBox="0 0 400 300" class="w-full h-full" preserveAspectRatio="xMidYMid slice">
      <text x="200" y="250" font-size="300" font-weight="700" text-anchor="middle"
        fill="#0f172a" font-family="ui-sans-serif,system-ui,sans-serif">?</text>
    </svg>`;

  const topicsArt = `
    <svg viewBox="0 0 400 300" class="w-full h-full" preserveAspectRatio="xMidYMid slice">
      ${[0, 1, 2, 3, 4].map((i) => `<rect x="${20 + i * 76}" y="40" width="70" height="14" rx="4" fill="#0f172a" opacity="${0.4 + i * 0.12}"/>`).join('')}
      ${Array.from({ length: 9 }, (_, i) => {
        const x = 24 + i * 41, y = 80 + (i % 3) * 66;
        return `<rect x="${x}" y="${y}" width="56" height="54" rx="6" fill="none" stroke="#0f172a" stroke-width="2"/>`;
      }).join('')}
    </svg>`;

  return `
    <div class="grid md:grid-cols-3 gap-6">
      ${door('openTopics', 'Topics',
        'One subject at a time — chapters from the article, the key events in order, a readable outline, and a quiz on it.',
        topicsArt, 'linear-gradient(90deg,#b45309,#65a30d)')}
      ${door('openAtlas', 'Atlas',
        'Every entry on one map — time across, similarity down. Zoom out for clusters, in for cards.',
        atlasArt, 'linear-gradient(90deg,#2563eb,#7c3aed)')}
      ${door('openQuiz', 'Quiz',
        'Pick a cluster and get asked what that entry can actually be asked. No excerpts to type.',
        quizArt, 'linear-gradient(90deg,#db2777,#f59e0b)')}
    </div>
  `;
}
