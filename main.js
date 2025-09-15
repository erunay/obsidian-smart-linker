
/* Smart Linker v0.2.8 - working panel + linking; built-in 'link' icon */
const { Plugin, Notice, ItemView, PluginSettingTab, Setting } = require('obsidian');

const VIEW_TYPE_SMART_LINKER = 'smart-linker-view';

/* === Stopwords & weights === */
const STOP = new Set([
  've','ile','de','da','mi','mu','mı','mü','bir','iki','çok','az','gibi','olan','olarak','için','ama','fakat','çünkü','veya','ya','ise','bu','şu','o','hangi','ne','nasıl','neden','hepsi','her','şey','daha','sonra','önce','ben','sen','o','biz','siz','onlar',
  'the','and','or','of','to','in','a','an','on','for','with','is','are','was','were','be','been','by','as','at','from','that','this','it','its','into','about','over','under','after','before','than','then','so','such','not','no','yes'
]);
const W = { TITLE: 3.5, HEADING: 2.5, TAG: 2.5, WIKILINK: 2.5, BODY: 1 };

/* === Tokenization & similarity === */
function tokenize(s) {
  return s.toLowerCase().normalize('NFKD')
    .replace(/[^\p{L}\p{N}\s#\[\]]/gu, ' ')
    .split(/\s+/)
    .filter(t => t && t.length >= 3 && !STOP.has(t) && !/^\d+$/.test(t));
}
function extractTokens(file, content) {
  const tokens = [];
  for (const t of tokenize(file.basename)) tokens.push({ t, w: W.TITLE });
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    if (line.startsWith('#')) for (const t of tokenize(line.replace(/^#+\s*/, ''))) tokens.push({ t, w: W.HEADING });
    const tagMatches = line.match(/(^|\s)#([A-Za-z0-9\-_]+)/g);
    if (tagMatches) for (const m of tagMatches) {
      const tag = m.replace(/[^A-Za-z0-9\-_]/g, '').toLowerCase();
      if (tag && tag.length >= 3) tokens.push({ t: tag, w: W.TAG });
    }
    const wl = [...line.matchAll(/\[\[([^\]]+)\]\]/g)];
    if (wl.length) for (const m of wl) {
      const inner = m[1].split('|')[0];
      for (const t of tokenize(inner)) tokens.push({ t, w: W.WIKILINK });
    }
    for (const t of tokenize(line)) tokens.push({ t, w: W.BODY });
  }
  return tokens;
}
function tfWeighted(tokens) { const m = new Map(); for (const {t,w} of tokens) m.set(t, (m.get(t)||0)+w); return m; }
function cosineSim(aVec, bVec, idf) {
  let dot=0,a2=0,b2=0;
  for (const [t,av] of aVec.entries()) {
    const idfw = idf.get(t)||1, aw = av*idfw; a2 += aw*aw;
    if (bVec.has(t)) dot += aw*(bVec.get(t)*idfw);
  }
  for (const [t,bv] of bVec.entries()) { const idfw=idf.get(t)||1; b2 += (bv*idfw)*(bv*idfw); }
  if (!a2 || !b2) return 0; return dot/(Math.sqrt(a2)*Math.sqrt(b2));
}

/* === View === */
class SmartLinkerView extends ItemView {
  constructor(leaf, plugin) { super(leaf); this.plugin = plugin; this.results = []; }
  getViewType() { return VIEW_TYPE_SMART_LINKER; }
  getDisplayText() { return "Smart Linker"; }
  getIcon() { return "link"; } // built-in icon (reliable)
  async onOpen() {
    this.containerEl.empty();
    const wrap = this.containerEl.createDiv({ cls: "smart-linker-container" });
    const header = wrap.createDiv({ cls: "smart-linker-header" });
    header.createEl("h3", { text: "Smart Linker" });
    const tools = header.createDiv({ cls: "smart-linker-toolbar" });
    const refresh = tools.createEl("button", { text: "Refresh" });
    const linkAll = tools.createEl("button", { text: "Link all" });
    refresh.addEventListener("click", () => this.plugin.refreshPanel());
    linkAll.addEventListener("click", () => this.linkAll());
    const info = wrap.createDiv({ cls: "smart-linker-info" });
    info.setText("Similarity favors titles, #tags and [[wikilinks]]. Tip: add keywords to titles; mark key terms as #tags or [[wikilinks]].");
    this.listEl = wrap.createDiv({ cls: "smart-linker-list" });
    await this.plugin.computeAndRender();
  }
  renderList() {
    this.listEl.empty();
    if (!this.results?.length) { this.listEl.createEl("div", { text: "No suggestions." }); return; }
    for (const r of this.results) {
      const row = this.listEl.createDiv({ cls: "smart-linker-item" });
      const left = row.createDiv({ cls: "smart-linker-left" });
      const right = row.createDiv({ cls: "smart-linker-right" });
      left.createEl("div", { cls: "smart-linker-title", text: r.file.basename });
      left.createEl("div", { cls: "smart-linker-path", text: r.file.path });
      left.createEl("div", { cls: "smart-linker-score", text: `Score: ${r.score.toFixed(3)} • Overlap: ${r.overlap}` });
      const openBtn = right.createEl("button", { text: "Open" });
      const linkBtn = right.createEl("button", { text: "Link" });
      openBtn.addEventListener("click", async () => { const leaf = this.plugin.app.workspace.getLeaf(true); await leaf.openFile(r.file); });
      linkBtn.addEventListener("click", async () => { await this.plugin.insertWikiLink(r.file); });
    }
  }
  setResults(results) { this.results = results; this.renderList(); }
  async linkAll() { if (!this.results?.length) { new Notice("Nothing to link."); return; } for (const r of this.results) await this.plugin.insertWikiLink(r.file, { silent: true }); new Notice("All suggestions linked."); }
}

/* === Settings === */
const DEFAULT_SETTINGS = { threshold: 0.12, minOverlap: 2, maxResults: 10, minNoteLength: 60 };
class SmartLinkerSettingTab extends PluginSettingTab {
  constructor(app, plugin) { super(app, plugin); this.plugin = plugin; }
  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl('h2', { text: 'Smart Linker Settings' });
    new Setting(containerEl).setName('Similarity threshold').setDesc('0.00–1.00 (higher = stricter)')
      .addText(t => t.setValue(String(this.plugin.settings.threshold)).onChange(async v => { const n=Number(v); if(!isNaN(n)){ this.plugin.settings.threshold=n; await this.plugin.saveSettings(); } }));
    new Setting(containerEl).setName('Minimum term overlap').setDesc('Min shared terms for a suggestion')
      .addText(t => t.setValue(String(this.plugin.settings.minOverlap)).onChange(async v => { const n=Number(v); if(!isNaN(n)){ this.plugin.settings.minOverlap=n; await this.plugin.saveSettings(); } }));
    new Setting(containerEl).setName('Max results').setDesc('How many items to show in the panel')
      .addText(t => t.setValue(String(this.plugin.settings.maxResults)).onChange(async v => { const n=Number(v); if(!isNaN(n)){ this.plugin.settings.maxResults=n; await this.plugin.saveSettings(); } }));
    new Setting(containerEl).setName('Min note length').setDesc('Ignore notes shorter than this many characters')
      .addText(t => t.setValue(String(this.plugin.settings.minNoteLength)).onChange(async v => { const n=Number(v); if(!isNaN(n)){ this.plugin.settings.minNoteLength=n; await this.plugin.saveSettings(); } }));
  }
}

/* === Plugin === */
module.exports = class SmartLinkerPlugin extends Plugin {
  async onload() {
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
    this.registerView(VIEW_TYPE_SMART_LINKER, (leaf) => new SmartLinkerView(leaf, this));
    // Built-in icon to avoid missing custom icon issues
    if (this.addRibbonIcon) this.addRibbonIcon('link', 'Open Smart Linker', async () => this.activateView());
    this.addCommand({ id: 'smart-linker-open-panel', name: 'Open Smart Linker panel', callback: async () => this.activateView() });
    this.addCommand({ id: 'smart-linker-find-similar', name: 'Find similar notes (notice)', callback: async () => this.findSimilarNotice() });
    this.addSettingTab(new SmartLinkerSettingTab(this.app, this));
    this.registerEvent(this.app.workspace.on('file-open', async () => { await this.computeAndRender(); }));
  }
  async onunload() { this.app.workspace.getLeavesOfType(VIEW_TYPE_SMART_LINKER).forEach(l => l.detach()); }
  async saveSettings() { await this.saveData(this.settings); }
  async activateView() {
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE_SMART_LINKER)[0];
    if (!leaf) { leaf = this.app.workspace.getRightLeaf(false); await leaf.setViewState({ type: VIEW_TYPE_SMART_LINKER, active: true }); }
    this.app.workspace.revealLeaf(leaf); await this.computeAndRender();
  }
  async computeAndRender() {
    const view = this.app.workspace.getLeavesOfType(VIEW_TYPE_SMART_LINKER)[0]?.view; if (!view) return;
    const activeFile = this.app.workspace.getActiveFile(); if (!activeFile) { view.setResults([]); return; }
    const results = await this.findSimilar(activeFile); view.setResults(results);
  }
  async findSimilarNotice() {
    const activeFile = this.app.workspace.getActiveFile(); if (!activeFile) { new Notice('No active note.'); return; }
    const results = await this.findSimilar(activeFile);
    if (!results.length) { new Notice('No similar notes found.'); return; }
    let msg = 'Top similar notes:\n'; for (const r of results) msg += `- ${r.file.path} (score: ${r.score.toFixed(3)})\n`; new Notice(msg, 10000);
  }
  async buildIndex(files) {
    const dfs = new Map(); const docs = [];
    for (const file of files) {
      const content = await this.app.vault.read(file);
      if ((content?.length||0) < this.settings.minNoteLength) continue;
      const toks = extractTokens(file, content); const tf = tfWeighted(toks);
      docs.push({ file, tf }); const seen = new Set(tf.keys()); for (const t of seen) dfs.set(t, (dfs.get(t)||0)+1);
    }
    const N = docs.length||1; const idf = new Map(); for (const [t,df] of dfs.entries()) idf.set(t, Math.log((N+1)/(df+1))+1);
    return { docs, idf };
  }
  async findSimilar(activeFile) {
    const files = this.app.vault.getMarkdownFiles(); const { docs, idf } = await this.buildIndex(files);
    const activeContent = await this.app.vault.read(activeFile); const activeTF = tfWeighted(extractTokens(activeFile, activeContent));
    const res = []; for (const d of docs) {
      if (d.file.path === activeFile.path) continue;
      let overlap = 0; for (const t of activeTF.keys()) if (d.tf.has(t)) overlap++;
      if (overlap < this.settings.minOverlap) continue;
      const score = cosineSim(activeTF, d.tf, idf); if (score >= this.settings.threshold) res.push({ file: d.file, score, overlap });
    }
    res.sort((a,b)=> b.score-a.score); return res.slice(0, this.settings.maxResults);
  }
  /* Append at bottom under a single 'Smart Link' section with real newlines */
  async insertWikiLink(targetFile, opts = {}) {
    try {
      const activeFile = this.app.workspace.getActiveFile();
      if (!activeFile) { new Notice("No active Markdown note."); return; }
      const linkText = `[[${targetFile.basename}]]`;
      let content = await this.app.vault.read(activeFile);
      const header = "\n---\n## Smart Link\nAdded by Smart Linker:\n";
      if (!content.includes("## Smart Link")) {
        content = (content.endsWith("\n") ? content : content + "\n") + header;
      } else {
        content = content.endsWith("\n") ? content : content + "\n";
      }
      if (!content.includes(linkText)) content += linkText + "\n";
      else if (!opts.silent) new Notice('This link already exists.');
      await this.app.vault.modify(activeFile, content);
      if (!opts.silent) new Notice(`Linked: ${linkText}`);
    } catch (e) {
      console.error('[Smart Linker] insertWikiLink error:', e); new Notice('Smart Linker: could not insert link.');
    }
  }
  refreshPanel() { this.computeAndRender(); }
};
