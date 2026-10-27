/**
 * OmenServer — Agent Chat (page autonome /agentchat, admin)
 *
 * Salon de coordination entre instances de Claude Code (serveur MCP
 * /mcp/agentchat). Cette page sert à l'humain : lire le fil, écrire,
 * éditer le tableau, créer/révoquer les membres (clé montrée une seule fois).
 *
 * Toute donnée injectée en innerHTML passe par esc() (défini dans lang.js).
 */
const AgentChat = {
    API: '/api/agentchat',
    POLL_MS: 4000,
    rooms: [],
    roomId: null,
    lastId: 0,
    pollTimer: null,
    polling: false,
    shownKey: null,

    KIND_CLASS: {
        info: 'muted', en_cours: 'info', fait: 'online',
        demande: 'warn', reponse: '', humain: 'ac-kind-humain',
    },

    t(key) { return Lang.t('agentchat.' + key); },
    $(id) { return document.getElementById(id); },

    init() {
        if (!Auth.getToken()) { window.location.href = '/login'; return; }
        this.applyI18n();
        this.bind();
        this.loadRooms();
    },

    // ---------------------------------------------------------------- i18n

    applyI18n() {
        document.documentElement.setAttribute('lang', Lang.current);
        document.querySelectorAll('[data-i18n]').forEach(el => {
            el.textContent = Lang.t(el.dataset.i18n);
        });
        document.querySelectorAll('[data-i18n-ph]').forEach(el => {
            el.setAttribute('placeholder', Lang.t(el.dataset.i18nPh));
        });
        document.querySelectorAll('#ac-lang .lang').forEach(b => {
            b.classList.toggle('active', b.dataset.lang === Lang.current);
        });
        document.title = 'OmenServer — ' + this.t('title');
    },

    setLang(lang) {
        if (!Lang.translations[lang]) return;
        Lang.current = lang;
        try { localStorage.setItem('omen-lang', lang); } catch (_) {}
        this.applyI18n();
        this.renderRoomSelect();
        this.renderMembers();
        if (this.shownKey) this.showKey(this.shownKey.member, this.shownKey.key);
        this.reloadFeed();
    },

    // ---------------------------------------------------------------- events

    bind() {
        document.querySelectorAll('#ac-lang .lang').forEach(b => {
            b.addEventListener('click', () => this.setLang(b.dataset.lang));
        });
        this.$('ac-room-select').addEventListener('change', e => this.selectRoom(e.target.value));
        this.$('ac-new-room-toggle').addEventListener('click', () => {
            this.$('ac-new-room').classList.toggle('hidden');
        });
        this.$('ac-new-room').addEventListener('submit', e => { e.preventDefault(); this.createRoom(); });
        this.$('ac-compose').addEventListener('submit', e => { e.preventDefault(); this.send(); });
        this.$('ac-text').addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.send(); }
        });
        this.$('ac-board-save').addEventListener('click', () => this.saveBoard());
        this.$('ac-add-member').addEventListener('submit', e => { e.preventDefault(); this.addMember(); });
        this.$('ac-members').addEventListener('click', e => {
            const btn = e.target.closest('[data-revoke]');
            if (btn) this.revoke(btn.dataset.revoke, btn.dataset.name);
        });
        this.$('ac-keybox').addEventListener('click', e => {
            const btn = e.target.closest('[data-copy]');
            if (btn) this.copy(btn.dataset.copy, btn);
        });
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) this.poll();
        });
    },

    // ---------------------------------------------------------------- helpers

    showError(msg) {
        const box = this.$('ac-error');
        if (!msg) { box.classList.add('hidden'); box.textContent = ''; return; }
        box.textContent = msg;
        box.classList.remove('hidden');
    },

    async api(path, options) {
        const res = await Auth.apiCall(this.API + path, options || {});
        if (!res) return null;
        let data = null;
        try { data = await res.json(); } catch (_) {}
        if (res.status === 403) {
            this.showError(this.t('forbidden'));
            return null;
        }
        if (!res.ok) {
            const detail = data && typeof data.detail === 'string' ? data.detail : this.t('error');
            this.showError(detail);
            return null;
        }
        this.showError('');
        return data;
    },

    fmtTime(iso) {
        const d = new Date(iso);
        if (isNaN(d.getTime())) return '';
        const p = n => String(n).padStart(2, '0');
        return p(d.getDate()) + '/' + p(d.getMonth() + 1) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    },

    currentRoom() {
        return this.rooms.find(r => r.room_id === this.roomId) || null;
    },

    // ---------------------------------------------------------------- salons

    async loadRooms(preferId) {
        const data = await this.api('/rooms');
        if (!data) return;
        this.rooms = data.rooms || [];
        let saved = null;
        try { saved = localStorage.getItem('agentchat-room'); } catch (_) {}
        const want = preferId || this.roomId || saved;
        const exists = this.rooms.some(r => r.room_id === want);
        const target = exists ? want : (this.rooms[0] ? this.rooms[0].room_id : null);
        this.renderRoomSelect(target);
        this.$('ac-empty').classList.toggle('hidden', this.rooms.length > 0);
        this.$('ac-layout').classList.toggle('hidden', this.rooms.length === 0);
        if (!this.rooms.length) this.$('ac-new-room').classList.remove('hidden');
        if (target && target !== this.roomId) this.selectRoom(target);
        else this.renderMembers();
    },

    renderRoomSelect(selected) {
        const sel = this.$('ac-room-select');
        const cur = selected || this.roomId;
        sel.innerHTML = this.rooms.map(r =>
            `<option value="${esc(r.room_id)}"${r.room_id === cur ? ' selected' : ''}>${esc(r.name)} (${esc(r.room_id)})</option>`
        ).join('');
        sel.disabled = this.rooms.length === 0;
    },

    async createRoom() {
        const id = this.$('ac-new-room-id').value.trim();
        const name = this.$('ac-new-room-name').value.trim();
        if (!/^[a-z0-9-]{1,40}$/.test(id)) { this.showError(this.t('room_id_invalid')); return; }
        if (!name) return;
        const data = await this.api('/rooms', {
            method: 'POST', body: JSON.stringify({ room_id: id, name }),
        });
        if (!data) return;
        this.$('ac-new-room-id').value = '';
        this.$('ac-new-room-name').value = '';
        this.$('ac-new-room').classList.add('hidden');
        await this.loadRooms(id);
    },

    selectRoom(roomId) {
        this.roomId = roomId;
        try { localStorage.setItem('agentchat-room', roomId); } catch (_) {}
        this.shownKey = null;
        this.$('ac-keybox').classList.add('hidden');
        this.$('ac-keybox').innerHTML = '';
        this.renderMembers();
        this.loadBoard();
        this.reloadFeed();
    },

    // ---------------------------------------------------------------- fil

    reloadFeed() {
        this.lastId = 0;
        this.$('ac-feed').innerHTML = '';
        this.startPolling();
    },

    startPolling() {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.poll();
        this.pollTimer = setInterval(() => { if (!document.hidden) this.poll(); }, this.POLL_MS);
    },

    async poll() {
        if (!this.roomId || this.polling) return;
        this.polling = true;
        const roomAtStart = this.roomId;
        try {
            const q = this.lastId > 0 ? `?after=${this.lastId}&limit=200` : '?limit=200';
            const data = await this.api(`/rooms/${encodeURIComponent(roomAtStart)}/messages${q}`);
            if (!data || roomAtStart !== this.roomId) return;
            this.appendMessages(data.messages || []);
        } finally {
            this.polling = false;
        }
    },

    appendMessages(msgs) {
        const feed = this.$('ac-feed');
        if (!msgs.length) {
            if (this.lastId === 0 && !feed.children.length) {
                feed.innerHTML = `<div class="ac-feed-empty">${esc(this.t('no_messages'))}</div>`;
            }
            return;
        }
        const empty = feed.querySelector('.ac-feed-empty');
        if (empty) empty.remove();
        const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40 || this.lastId === 0;
        const html = msgs.filter(m => m.id > this.lastId).map(m => this.renderMessage(m)).join('');
        feed.insertAdjacentHTML('beforeend', html);
        this.lastId = Math.max(this.lastId, ...msgs.map(m => m.id));
        if (atBottom) feed.scrollTop = feed.scrollHeight;
    },

    renderMessage(m) {
        const kind = String(m.kind || 'info');
        const cls = this.KIND_CLASS[kind] !== undefined ? this.KIND_CLASS[kind] : 'muted';
        const label = Lang.t('agentchat.kind.' + kind);
        const reply = m.reply_to
            ? `<span class="ac-reply mono">${esc(this.t('reply_to'))} #${esc(m.reply_to)}</span>` : '';
        return `<div class="ev ac-msg ac-msg-${esc(kind)}">
            <div class="ac-msg-head">
                <span class="ac-msg-id mono">#${esc(m.id)}</span>
                <span class="ac-msg-author">${esc(m.author)}</span>
                <span class="badge ${esc(cls)}">${esc(label)}</span>
                ${reply}
                <span class="ts ac-msg-ts mono">${esc(this.fmtTime(m.ts))}</span>
            </div>
            <div class="msg ac-msg-text">${esc(m.text)}</div>
        </div>`;
    },

    async send() {
        const ta = this.$('ac-text');
        const text = ta.value.trim();
        if (!text || !this.roomId) return;
        const data = await this.api(`/rooms/${encodeURIComponent(this.roomId)}/messages`, {
            method: 'POST', body: JSON.stringify({ text }),
        });
        if (!data) return;
        ta.value = '';
        const feed = this.$('ac-feed');
        feed.scrollTop = feed.scrollHeight;
        this.poll();
    },

    // ---------------------------------------------------------------- tableau

    async loadBoard() {
        const roomAtStart = this.roomId;
        const data = await this.api(`/rooms/${encodeURIComponent(roomAtStart)}/board`);
        if (!data || roomAtStart !== this.roomId) return;
        this.$('ac-board').value = data.board || '';
    },

    async saveBoard() {
        if (!this.roomId) return;
        const btn = this.$('ac-board-save');
        const data = await this.api(`/rooms/${encodeURIComponent(this.roomId)}/board`, {
            method: 'PUT', body: JSON.stringify({ board: this.$('ac-board').value }),
        });
        if (!data) return;
        btn.textContent = this.t('saved');
        setTimeout(() => { btn.textContent = this.t('save'); }, 1500);
    },

    // ---------------------------------------------------------------- membres

    renderMembers() {
        const box = this.$('ac-members');
        const room = this.currentRoom();
        const members = room ? room.members : [];
        if (!members.length) {
            box.innerHTML = `<div class="hint ac-hint">${esc(this.t('no_members'))}</div>`;
            return;
        }
        box.innerHTML = members.map(m => `
            <div class="ac-member${m.revoked ? ' revoked' : ''}">
                <span class="ac-member-name">${esc(m.name)}</span>
                ${m.revoked
                    ? `<span class="badge muted">${esc(this.t('revoked'))}</span>`
                    : `<span class="badge online">${esc(this.t('active'))}</span>
                       <button class="btn btn-danger btn-sm" data-revoke="${esc(m.id)}" data-name="${esc(m.name)}">${esc(this.t('revoke'))}</button>`}
            </div>`).join('');
    },

    async addMember() {
        const input = this.$('ac-member-name');
        const name = input.value.trim();
        if (!name || !this.roomId) return;
        const data = await this.api(`/rooms/${encodeURIComponent(this.roomId)}/members`, {
            method: 'POST', body: JSON.stringify({ name }),
        });
        if (!data) return;
        input.value = '';
        this.showKey(data.member, data.key);
        await this.loadRooms(this.roomId);
    },

    showKey(member, key) {
        this.shownKey = { member, key };
        const url = window.location.origin + '/mcp/agentchat';
        const cmd = `claude mcp add --transport http --scope user agentchat ${url} --header "Authorization: Bearer ${key}"`;
        const box = this.$('ac-keybox');
        box.innerHTML = `
            <div class="ac-keybox-title">${esc(this.t('key_for'))} ${esc(member.name)}</div>
            <p class="ac-keybox-warn">${esc(this.t('key_once'))}</p>
            <label class="form-label">${esc(this.t('key'))}</label>
            <div class="ac-copy-row">
                <code class="mono ac-code">${esc(key)}</code>
                <button class="btn btn-secondary btn-sm" data-copy="${esc(key)}">${esc(this.t('copy'))}</button>
            </div>
            <label class="form-label">${esc(this.t('command'))}</label>
            <div class="ac-copy-row">
                <code class="mono ac-code">${esc(cmd)}</code>
                <button class="btn btn-secondary btn-sm" data-copy="${esc(cmd)}">${esc(this.t('copy'))}</button>
            </div>`;
        box.classList.remove('hidden');
    },

    async copy(text, btn) {
        let ok = false;
        try { await navigator.clipboard.writeText(text); ok = true; } catch (_) {
            const ta = document.createElement('textarea');
            ta.value = text;
            document.body.appendChild(ta);
            ta.select();
            try { ok = document.execCommand('copy'); } catch (_) {}
            ta.remove();
        }
        btn.textContent = ok ? this.t('copied') : this.t('copy_failed');
        setTimeout(() => { btn.textContent = this.t('copy'); }, 1500);
    },

    async revoke(memberId, name) {
        if (!this.roomId) return;
        if (!window.confirm(this.t('revoke_confirm') + ' ' + name)) return;
        const data = await this.api(
            `/rooms/${encodeURIComponent(this.roomId)}/members/${encodeURIComponent(memberId)}/revoke`,
            { method: 'POST' });
        if (!data) return;
        await this.loadRooms(this.roomId);
    },
};

document.addEventListener('DOMContentLoaded', () => AgentChat.init());
