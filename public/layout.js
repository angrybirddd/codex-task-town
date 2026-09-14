// Layout is a presentation concern. Never send movement decisions back to Codex.
export const WIDTH = 1200, HEIGHT = 800;
export const SLOTS = [
  { x: 180, y: 288, area: 'work', label: '窗边工作台' },
  { x: 420, y: 288, area: 'work', label: '窗边工作台' },
  { x: 670, y: 290, area: 'plan', label: '白板讨论区' },
  { x: 968, y: 286, area: 'test', label: '测试工作台' },
  { x: 395, y: 497, area: 'work', label: '共享长桌' },
  { x: 660, y: 502, area: 'work', label: '共享长桌' },
  { x: 1010, y: 499, area: 'read', label: '阅读角' },
  { x: 160, y: 525, area: 'plan', label: '灵感角' },
  { x: 188, y: 702, area: 'rest', label: '咖啡角' },
  { x: 939, y: 705, area: 'rest', label: '沙发休息区' },
  { x: 532, y: 705, area: 'work', label: '移动工作台' }
];
const areaFor = t => t.displayState === 'idle' ? 'rest' :
  t.role === 'testing' ? 'test' : t.role === 'docs' ? 'read' : t.role === 'ops' ? 'plan' : 'work';
export class StudioLayout {
  constructor() { this.places = new Map(); }
  update(tasks, retained = tasks) {
    const present = new Set(retained.map(t => t.id));
    for (const id of this.places.keys()) if (!present.has(id)) this.places.delete(id);
    // Each logical room hosts eight residents. Filtering does not assign new seats.
    for (let start = 0; start < tasks.length; start += 8) {
      const group = tasks.slice(start, start + 8), used = new Set();
      for (const t of group) {
        const old = this.places.get(t.id);
        const idle = t.displayState === 'idle';
        const freeze = ['unknown', 'waiting', 'error', 'paused', 'ended', 'review'].includes(t.displayState);
        if (old && (freeze || old.idle === idle) && !used.has(old.index)) used.add(old.index);
        else this.places.delete(t.id);
      }
      for (const t of group) {
        if (this.places.has(t.id)) continue;
        const preferred = areaFor(t);
        let index = SLOTS.findIndex((s, i) => s.area === preferred && !used.has(i));
        // Never send a working resident to the lounge just because desks are busy.
        if (index < 0) index = SLOTS.findIndex((s, i) => s.area !== 'rest' && !used.has(i));
        if (index < 0) index = SLOTS.findIndex((s, i) => !used.has(i));
        used.add(index); this.places.set(t.id, { index, idle: t.displayState === 'idle' });
      }
    }
  }
  get(id) { return SLOTS[this.places.get(id)?.index ?? 0]; }
}
