import { WIDTH, HEIGHT } from './layout.js';
// Original procedural artwork. No external assets, fonts or generation at runtime.
const palette = ['#7b9d86', '#b38b70', '#87a6ae', '#b58797', '#abb17f', '#8d90ab'];
const seedOf = id => [...String(id)].reduce((s, c) => (s * 31 + c.charCodeAt(0)) >>> 0, 7);
function rect(c, color, x, y, w, h) { c.fillStyle = color; c.fillRect(Math.round(x), Math.round(y), w, h); }
function plant(c, x, y, size = 1) {
  const r = (co, a, b, w, h) => rect(c, co, x + a * size, y + b * size, w * size, h * size);
  r('#8da986', -3, -54, 6, 60); r('#799877', -27, -41, 23, 17); r('#98b28e', -29, -46, 19, 12);
  r('#a7bc8c', 0, -60, 16, 28); r('#7f9e76', 3, -29, 26, 15); r('#b7c696', 13, -35, 18, 12);
  r('#b1846c', -18, 0, 36, 29); r('#d0a181', -21, -3, 42, 9); r('#dcb190', -12, 6, 9, 17);
}
function label(c, text, x, y, color = '#8b8e76') {
  c.fillStyle = color; c.font = '12px monospace'; c.textAlign = 'center'; c.fillText(text, x, y);
}
function windowArt(c, x, y, w = 165) {
  rect(c, '#c8c8ac', x - 6, y - 6, w + 12, 110); rect(c, '#faf2d8', x, y, w, 103);
  rect(c, '#cfe1d4', x + 6, y + 6, w - 12, 90);
  rect(c, '#afc8a5', x + 6, y + 64, w - 12, 32); rect(c, '#dce6c4', x + 6, y + 81, w - 12, 15);
  for (let i = 0; i < 5; i++) rect(c, '#92b28f', x + 10 + i * 31, y + 61 - (i % 3) * 7, 22, 27);
  rect(c, '#edf3df', x + 20, y + 18, 42, 6); rect(c, '#edf3df', x + 95, y + 26, 39, 6);
  rect(c, '#f9eed3', x + w / 2 - 3, y, 6, 102); rect(c, '#f9eed3', x, y + 49, w, 5);
  rect(c, '#c5b999', x - 13, y + 102, w + 26, 7); rect(c, '#ece0bd', x - 15, y + 98, w + 30, 6);
  rect(c, '#adbaa1', x - 15, y - 9, 15, 92); rect(c, '#c4cfb1', x - 12, y - 8, 7, 87);
  rect(c, '#adbaa1', x + w, y - 9, 15, 92); rect(c, '#c4cfb1', x + w + 3, y - 8, 7, 87);
}
function table(c, x, y, w, h = 54) {
  rect(c, '#b6aa8d', x + 8, y + h, w - 4, 16);
  rect(c, '#a88763', x + 11, y + h - 2, 9, 32); rect(c, '#a88763', x + w - 21, y + h - 2, 9, 32);
  rect(c, '#c79f76', x, y + 6, w, h); rect(c, '#e6c49a', x - 3, y, w + 6, h - 7);
  rect(c, '#f1d9b4', x, y + 1, w, 5); rect(c, '#bd956b', x, y + h - 7, w, 5);
  for (let k = 0; k < w - 20; k += 63) rect(c, '#d9b78e', x + 10 + k, y + 20, 38, 2);
}
function laptop(c, x, y, active = true, frame = 0) {
  rect(c, '#647a70', x, y, 45, 30); rect(c, '#aec9b2', x + 4, y + 4, 37, 21);
  for (let i = 0; i < 3; i++) rect(c, active ? '#f0edcc' : '#c4d9bf', x + 8, y + 8 + i * 5, 12 + (i + Math.floor(frame / 8)) % 3 * 5, 2);
  rect(c, '#8c9d88', x - 5, y + 30, 55, 8); rect(c, '#bbc6ac', x + 1, y + 31, 42, 3);
}
function bookshelf(c, x, y) {
  rect(c, '#9f8a6c', x, y, 160, 128); rect(c, '#c9b394', x + 7, y + 6, 146, 114);
  for (let shelf = 0; shelf < 3; shelf++) {
    for (let j = 0; j < 11; j++) {
      const h = 18 + ((j + shelf) % 3) * 6;
      rect(c, palette[(j + shelf) % palette.length], x + 12 + j * 12, y + 36 + shelf * 37 - h, 9, h);
      rect(c, '#dfd7b6', x + 13 + j * 12, y + 34 + shelf * 37 - h, 7, 3);
    }
    rect(c, '#a18765', x + 3, y + 36 + shelf * 37, 154, 6);
  }
}
function rug(c, x, y, w, h, color) {
  rect(c, '#c7bba2', x + 3, y + 4, w, h); rect(c, color, x, y, w, h);
  c.strokeStyle = '#f0e5c9'; c.lineWidth = 3; c.strokeRect(x + 10, y + 10, w - 20, h - 20);
  for (let i = 10; i < w; i += 12) { rect(c, '#d9d0ad', x + i, y - 3, 3, 5); rect(c, '#d9d0ad', x + i, y + h - 1, 3, 5); }
}
function background(c) {
  rect(c, '#dce7cd', 0, 0, WIDTH, HEIGHT);
  for (let i = 0; i < 100; i++) rect(c, '#c4d4b4', (i * 167 + 29) % WIDTH, (i * 71) % HEIGHT, 5, 3);
  rect(c, '#b9c6a7', 34, 29, 1149, 729); rect(c, '#899b83', 23, 20, 1148, 724);
  rect(c, '#eddfbe', 33, 30, 1128, 702); rect(c, '#f4ecd7', 39, 30, 1116, 154);
  rect(c, '#c5b38e', 39, 175, 1116, 8); rect(c, '#e8d1aa', 39, 183, 1116, 547);
  for (let y = 190, row = 0; y < 728; y += 32, row++) {
    rect(c, '#d9c09a', 39, y + 31, 1116, 1);
    for (let x = 39 + row % 2 * 80; x < 1153; x += 160) {
      rect(c, '#d9c09a', x, y, 1, 31); rect(c, '#e0c6a0', x + 15, y + 13, 48, 1);
    }
  }
  windowArt(c, 118, 50); windowArt(c, 357, 50);
  // Warm sunlight from the windows, kept underneath furniture and inhabitants.
  c.fillStyle = '#fff0c950';
  for (const x of [125, 365]) { c.beginPath(); c.moveTo(x, 184); c.lineTo(x + 145, 184); c.lineTo(x + 285, 385); c.lineTo(x + 60, 385); c.fill(); }
  rect(c, '#bcac8a', 580, 51, 182, 113); rect(c, '#faf4dc', 586, 57, 170, 101);
  label(c, 'ONE THING AT A TIME', 671, 79);
  for (const [x,y,col] of [[602,96,'#bfcba3'],[646,97,'#e3c393'],[696,95,'#b9cbd0'],[626,129,'#d8a79b'],[682,130,'#cbd4b0']]) rect(c, col, x,y,30,18);
  label(c, 'THE SHARED STUDIO', 972, 73, '#687e66');
  rect(c, '#c5ceb1', 881, 91, 184, 36); label(c, 'LESS NOISE. MORE MAKING.', 972, 114, '#718468');
  // Work area: one continuous window bench, not an array of identical desks.
  rug(c, 95, 224, 426, 108, '#c2cdae'); table(c, 98, 290, 421, 38);
  plant(c, 309, 283, .5); rect(c, '#f7f0d7', 340, 304, 27, 16);
  // Testing bench and wall-mounted screens.
  table(c, 846, 286, 269, 42);
  for (const x of [868, 1003]) { rect(c, '#6f8176', x, 162, 90, 60); rect(c, '#aac4b2', x+6,168,78,46); rect(c,'#7e9485',x+39,221,13,18); }
  for (let i=0;i<3;i++) { rect(c,'#e1e9c9',881,181+i*9,51-i*9,3); rect(c,'#cfdaaf',1017+i*20,196-i*9,12,15+i*9); }
  label(c, 'BUILD & TEST', 981, 355);
  // Central shared island, staggered chairs and a notebook, with plenty of floor around it.
  rug(c, 293, 416, 461, 147, '#b6c3ac'); table(c, 305, 497, 439, 50);
  plant(c, 532, 481, .6); rect(c, '#f6e9ca', 477, 509, 35, 20); rect(c, '#cbb99a', 492, 510, 2, 18);
  rect(c, '#bda182', 81, 354, 180, 10); label(c, 'IDEAS WELCOME', 170, 391);
  rect(c, '#bba78b', 124, 431, 92, 66); rect(c, '#f1e7cf', 130, 437, 80, 54);
  rect(c, '#829a86', 135, 448, 65, 3); rect(c, '#c5b18c', 139, 460, 44, 3);
  // Library at the right, full-height residents in front instead of behind monitors.
  bookshelf(c, 963, 348); rug(c, 906, 458, 220, 82, '#c9b6a4');
  // Lounge and coffee corner only host explicitly idle inhabitants.
  rug(c, 832, 612, 291, 106, '#c5c9ad');
  rect(c, '#9aa98e', 855, 621, 242, 60); rect(c, '#b6c5a5', 867, 615, 218, 38);
  rect(c, '#c9d2b2', 873, 622, 91, 29); rect(c, '#bdcaaa', 975, 622, 100, 29);
  rect(c, '#849c80', 855, 646, 15, 43); rect(c, '#849c80', 1082, 646, 15, 43);
  rect(c, '#dac393', 880, 657, 44, 19); label(c, 'TAKE A BREATH', 979, 747);
  table(c, 88, 638, 199, 47); rect(c, '#809486', 99, 590, 54, 48);
  rect(c, '#d0d8bc', 106, 597, 40, 12); rect(c, '#c7aa85', 113, 617, 21, 13);
  rect(c, '#ede8d1', 237, 625, 23, 20); rect(c, '#bbaa87', 241, 626, 15, 4);
  label(c, 'COFFEE & QUIET', 190, 747);
  table(c, 464, 704, 132, 26);
  for (const [x,y,s] of [[ 62,225,1],[1140,271,.8],[808,425,.9],[777,695,1],[54,705,.65]]) plant(c,x,y,s);
  rect(c, '#c2b18d', 475, 734, 214, 18); rect(c, '#d8c39e', 462, 750, 240, 13);
  label(c, 'A PLACE FOR EVERY LITTLE TASK', 589, 786, '#879b7d');
}
export function avatar(c, x, y, task = {}, frame = 0, scale = 3) {
  const seed = seedOf(task.id || 'visitor'), state = task.displayState || task.state || 'idle';
  const active = ['coding', 'reading', 'testing', 'thinking', 'running'].includes(state);
  const bounce = active && Math.floor(frame / 5) % 2 ? 1 : 0;
  const r = (color, a, b, w, h) => rect(c, color, x + (a - 8) * scale, y + (b - 21 - bounce) * scale, w * scale, h * scale);
  c.save(); if (state === 'unknown' || state === 'ended') c.globalAlpha = .52;
  const coat = palette[seed % palette.length], hair = ['#645546', '#887252', '#544f4a', '#a17b50'][seed % 4];
  const skin = ['#e8bf92', '#d4a77d', '#f0cdaa', '#be9470'][Math.floor(seed / 5) % 4];
  r('#a8ad87', 2, 20, 13, 2); r('#655f51', 4, 18, 4, 3); r('#655f51', 10, 18, 4, 3);
  r('#6f7668', 4, 15, 10, 4); r(coat, 3, 10, 12, 7); r('#ddd4b1', 8, 11, 2, 6);
  r(skin, 5, 4, 8, 7); r(skin, 4, 6, 1, 3); r(skin, 13, 6, 1, 3);
  r(hair, 4, 2, 10, 4); r(hair, 5, 1, 8, 2); r(hair, 4, 5, 2, 3); r(hair, 12, 5, 2, 2);
  const blink = frame % 71 === 0;
  r('#454c41', 7, 7, 1, blink ? .4 : 1); r('#454c41', 11, 7, 1, blink ? .4 : 1); r('#b58b69', 9, 9, 2, 1);
  const handY = state === 'coding' || state === 'testing' ? 14 + (frame % 6 < 3 ? 0 : 1) : 15;
  r(skin, 2, handY, 3, 3); r(skin, 14, handY, 2, 3);
  if (task.role === 'frontend') { r('#baa375', 3, 2, 12, 2); r('#ddc894', 4, 0, 9, 3); r('#89a077', 12, 0, 2, 2); }
  if (task.role === 'backend') { r('#566d64', 3, 5, 2, 5); r('#566d64', 14, 5, 2, 5); r('#9ab6a1', 3, 6, 1, 3); }
  if (task.role === 'testing') { r('#626c60', 6, 6, 4, 3); r('#626c60', 11, 6, 4, 3); r('#a8c3b5', 7, 7, 2, 1); r('#a8c3b5', 12, 7, 2, 1); }
  if (task.role === 'ops') { r('#8fa273', 3, 2, 12, 3); r('#adc28b', 5, 0, 8, 3); }
  if (task.role === 'docs' || state === 'reading' || state === 'review') {
    r('#f3ecd0', 11, 12, 6, 7); r('#c4b58f', 13, 13, 3, 1); r('#c4b58f', 13, 15, 3, 1);
  }
  if (state === 'idle') { r('#f5ebcf', 14, 14, 4, 4); r('#a39575', 15, 14, 2, 1); r('#f5ebcf', 18, 15, 1, 2); }
  if (state === 'waiting') { r('#b6a274', 15, 6, 1, 12); r('#e8d79b', 13, 3, 6, 6); r('#aa874b', 15, 4, 2, 3); }
  if (state === 'error') { r('#bd805f', 15, 3, 3, 5); r('#bd805f', 16, 9, 1, 1); }
  c.restore();
}

export class TownScene {
  constructor(canvas, portrait) {
    this.canvas = canvas; this.portrait = portrait; this.tasks = []; this.selected = null; this.layout = null;
    this.frame = 1; this.paused = matchMedia('(prefers-reduced-motion: reduce)').matches;
    this.bg = document.createElement('canvas'); this.bg.width = WIDTH; this.bg.height = HEIGHT;
    background(this.bg.getContext('2d'));
    this.tick = () => {
      clearTimeout(this.timer); this.timer = null;
      if (!this.paused && !document.hidden && this.tasks.length) { this.frame++; this.draw(); this.timer = setTimeout(this.tick, 100); }
    };
    document.addEventListener('visibilitychange', this.tick);
    this.motion = matchMedia('(prefers-reduced-motion: reduce)');
    this.motion.addEventListener('change', event => { this.setPaused(event.matches); });
    this.tick();
  }
  setPaused(value) { this.paused = value; this.tick(); this.draw(); this.onPauseChange?.(); }
  update(tasks, selected, layout) { this.tasks = tasks; this.selected = selected; this.layout = layout; this.draw();
    if (!tasks.length) { clearTimeout(this.timer); this.timer = null; }
    else if (!this.timer) this.tick();
  }
  draw() {
    const c = this.canvas.getContext('2d'); c.imageSmoothingEnabled = false; c.drawImage(this.bg, 0, 0);
    if (this.layout) for (const t of [...this.tasks].sort((a,b) => this.layout.get(a.id).y - this.layout.get(b.id).y)) {
      const { x, y } = this.layout.get(t.id), frame = this.paused ? 1 : this.frame;
      if (t.id === this.selected?.id) {
        c.fillStyle = '#7f9e7540'; c.beginPath(); c.ellipse(x,y+2,34,10,0,0,Math.PI*2); c.fill();
      }
      avatar(c, x, y, t, frame, 3.6);
      // A small laptop never hides the resident's face or outfit.
      if (['coding','testing','running'].includes(t.displayState)) laptop(c, x+24, y-22, true, frame);
      if (t.displayState === 'unknown') label(c, '?', x+38, y-58, '#7e8678');
    }
    const p = this.portrait.getContext('2d'); p.clearRect(0, 0, 96, 96); p.imageSmoothingEnabled = false;
    avatar(p, 45, 84, this.selected || { id: 'visitor', state: 'idle' }, this.paused ? 1 : this.frame, 3);
  }
}
