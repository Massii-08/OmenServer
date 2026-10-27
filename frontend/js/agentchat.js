/**
 * OmenServer — Agent Chat (vue SPA « Discussion », onglet de la top bar)
 *
 * Salon de coordination entre instances de Claude Code (serveur MCP
 * /mcp/agentchat). Cette vue sert à l'humain : lire le fil, écrire, éditer
 * le tableau ; l'admin crée aussi les salons et gère les clés des membres
 * (clé montrée une seule fois).
 *
 * Accès : admin ou rôle developer (lecture/écriture) ; gestion salons/clés =
 * admin seulement (masquée dans l'UI ET refusée par le backend).
 *
 * Toute donnée injectée en innerHTML passe par esc() (défini dans lang.js).
 * La page /agentchat redirige vers /#agentchat (une seule UI).
 */
const AgentChatModule = {
    API: '/api/agentchat',
    POLL_MS: 4000,
    rooms: [],
    roomId: null,
    lastId: 0,
    pollTimer: null,
    polling: false,
    gen: 0,              // incrémenté à chaque render/unload : invalide les réponses en vol
    shownKey: null,      // { roomId, member, key } — survit à un re-render (changement de langue)
    _feedRoom: null,
    _visBound: false,

    KIND_CLASS: {
        info: 'muted', en_cours: 'info', fait: 'online',
        demande: 'warn', reponse: '', humain: 'ac-kind-humain',
    },

    t(key) { return Lang.t('agentchat.' + key); },
    $(id) { return document.getElementById(id); },

    canManage() {
        const u = Auth.getUser();
        return !!(u && u.is_admin);
    },

    // ---------------------------------------------------------------- cycle de vie

    render(container) {
        this.unload();
        const manage = this.canManage();
        const t = k => esc(this.t(k));
        container.innerHTML = `
        <div class="ac-view">
            <div class="page-header">
                <h1 class="page-title">${t('title')}</h1>
                <p class="page-subtitle">${t('subtitle')}</p>
            </div>

            <section class="ac-toolbar card">
                <label class="form-label" for="ac-room-select">${t('room')}</label>
                <div class="ac-toolbar-row">
                    <select class="form-input" id="ac-room-select"></select>
                    ${manage ? `<button class="btn btn-secondary btn-sm" id="ac-new-room-toggle">${t('new_room')}</button>` : ''}
                </div>
                ${manage ? `
                <form class="ac-new-room hidden" id="ac-new-room">
                    <input class="form-input mono" id="ac-new-room-id" maxlength="40" required pattern="[a-z0-9-]{1,40}" placeholder="${t('room_id_ph')}">
                    <input class="form-input" id="ac-new-room-name" maxlength="60" required placeholder="${t('room_name_ph')}">
                    <button class="btn btn-primary btn-sm" type="submit">${t('create')}</button>
                </form>` : ''}
                <div class="ac-error hidden" id="ac-error" role="alert"></div>
            </section>

            <div class="ac-empty hidden" id="ac-empty">${t(manage ? 'no_rooms' : 'no_rooms_dev')}</div>

            <div class="ac-layout hidden" id="ac-layout">
                <section class="ac-main card">
                    <h2 class="ac-h2">${t('messages')}</h2>
                    <div class="events-feed ac-feed" id="ac-feed" aria-live="polite"></div>
                    <form class="ac-compose" id="ac-compose">
                        <textarea class="form-input" id="ac-text" rows="2" maxlength="4000" placeholder="${t('compose_ph')}"></textarea>
                        <button class="btn btn-primary btn-sm" type="submit">${t('send')}</button>
                    </form>
                </section>

                <aside class="ac-side">
                    <section class="card ac-panel">
                        <h2 class="ac-h2">${t('board')}</h2>
                        <p class="hint ac-hint">${t('board_hint')}</p>
                        <textarea class="form-input mono" id="ac-board" rows="8" maxlength="8000"></textarea>
                        <button class="btn btn-secondary btn-sm" id="ac-board-save">${t('save')}</button>
                    </section>

                    <section class="card ac-panel">
                        <h2 class="ac-h2">${t('members')}</h2>
                        ${manage ? `
                        <form class="ac-add-member" id="ac-add-member">
                            <input class="form-input" id="ac-member-name" maxlength="60" required placeholder="${t('member_name_ph')}">
                            <button class="btn btn-primary btn-sm" type="submit">${t('add_member')}</button>
                        </form>
                        <div class="ac-keybox hidden" id="ac-keybox"></div>` : ''}
                        <div class="ac-members" id="ac-members"></div>
                    </section>
                </aside>
            </div>
        </div>`;
        this.bind(manage);
        this.loadRooms();
    },

    /** Arrête le polling et invalide toute réponse encore en vol. */
    unload() {
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.pollTimer = null;
        this.polling = false;
        this._feedRoom = null;
        this.gen++;
    },

    alive(gen) { return gen === this.gen && !!this.$('ac-feed'); },

    // ---------------------------------------------------------------- events

    bind(manage) {
        this.$('ac-room-select').addEventListener('change', e => this.selectRoom(e.target.value));
        this.$('ac-compose').addEventListener('submit', e => { e.preventDefault(); this.send(); });
        this.$('ac-text').addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.send(); }
        });
        this.$('ac-board-save').addEventListener('click', () => this.saveBoard());
        this.$('ac-members').addEventListener('click', e => {
            const btn = e.target.closest('[data-revoke]');
            if (btn) this.revoke(btn.dataset.revoke, btn.dataset.name);
        });
        if (manage) {
            this.$('ac-new-room-toggle').addEventListener('click', () => {
                this.$('ac-new-room').classList.toggle('hidden');
            });
            this.$('ac-new-room').addEventListener('submit', e => { e.preventDefault(); this.createRoom(); });
            this.$('ac-add-member').addEventListener('submit', e => { e.preventDefault(); this.addMember(); });
            this.$('ac-keybox').addEventListener('click', e => {
                const btn = e.target.closest('[data-copy]');
                if (btn) this.copy(btn.dataset.copy, btn);
            });
        }
        if (!this._visBound) {
            this._visBound = true;
            document.addEventListener('visibilitychange', () => {
                if (!document.hidden && this.pollTimer) this.poll();
            });
        }
    },

    // ---------------------------------------------------------------- helpers

    showError(msg) {
        const box = this.$('ac-error');
        if (!box) return;
        if (!msg) { box.classList.add('hidden'); box.textContent = ''; return; }
        box.textContent = msg;
        box.classList.remove('hidden');
    },

    async api(path, options) {
        const gen = this.gen;
        const res = await Auth.apiCall(this.API + path, options || {});
        if (!res || !this.alive(gen)) return null;
        let data = null;
        try { data = await res.json(); } catch (_) {}
        if (!this.alive(gen)) return null;
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

    async loadRooms() {
        const data = await this.api('/rooms');
        if (!data) return;
        this.rooms = data.rooms || [];
        let saved = null;
        try { saved = localStorage.getItem('agentchat-room'); } catch (_) {}
        const want = this.roomId || saved;
        const target = this.rooms.some(r => r.room_id === want)
            ? want : (this.rooms[0] ? this.rooms[0].room_id : null);
        this.roomId = target;
        this.renderRoomSelect();
        this.$('ac-empty').classList.toggle('hidden', this.rooms.length > 0);
        this.$('ac-layout').classList.toggle('hidden', this.rooms.length === 0);
        const newRoom = this.$('ac-new-room');
        if (!this.rooms.length && newRoom) newRoom.classList.remove('hidden');
        if (!target) return;
        if (target === this._feedRoom) this.renderMembers();  // même salon : liste rafraîchie seulement
        else this.selectRoom(target);
    },

    renderRoomSelect() {
        const sel = this.$('ac-room-select');
        sel.innerHTML = this.rooms.map(r =>
            `<option value="${esc(r.room_id)}"${r.room_id === this.roomId ? ' selected' : ''}>${esc(r.name)} (${esc(r.room_id)})</option>`
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
        this.roomId = id;
        await this.loadRooms();
    },

    selectRoom(roomId) {
        this.roomId = roomId;
        this._feedRoom = roomId;
        try { localStorage.setItem('agentchat-room', roomId); } catch (_) {}
        if (this.shownKey && this.shownKey.roomId !== roomId) this.shownKey = null;
        this.renderKey();
        this.renderMembers();
        this.loadBoard();
        this.reloadFeed();
    },

    // ---------------------------------------------------------------- fil

    reloadFeed() {
        this.lastId = 0;
        this.$('ac-feed').innerHTML = '';
        if (this.pollTimer) clearInterval(this.pollTimer);
        this.polling = false;
        this.poll();
        this.pollTimer = setInterval(() => { if (!document.hidden) this.poll(); }, this.POLL_MS);
    },

    async poll() {
        if (!this.roomId || this.polling) return;
        this.polling = true;
        const roomAtStart = this.roomId;
        const gen = this.gen;
        try {
            const q = this.lastId > 0 ? `?after=${this.lastId}&limit=200` : '?limit=200';
            const data = await this.api(`/rooms/${encodeURIComponent(roomAtStart)}/messages${q}`);
            if (!data || roomAtStart !== this.roomId || !this.alive(gen)) return;
            this.appendMessages(data.messages || []);
        } finally {
            if (gen === this.gen) this.polling = false;
        }
    },

    appendMessages(msgs) {
        const feed = this.$('ac-feed');
        if (!feed) return;
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
        const data = await this.api(`/rooms/${encodeURIComponent(this.roomId)}/board`, {
            method: 'PUT', body: JSON.stringify({ board: this.$('ac-board').value }),
        });
        if (!data) return;
        const btn = this.$('ac-board-save');
        btn.textContent = this.t('saved');
        setTimeout(() => { if (btn.isConnected) btn.textContent = this.t('save'); }, 1500);
    },

    // ---------------------------------------------------------------- membres

    renderMembers() {
        const box = this.$('ac-members');
        if (!box) return;
        const room = this.currentRoom();
        const members = room ? room.members : [];
        const manage = this.canManage();
        if (!members.length) {
            box.innerHTML = `<div class="hint ac-hint">${esc(this.t(manage ? 'no_members' : 'no_members_dev'))}</div>`;
            return;
        }
        box.innerHTML = members.map(m => `
            <div class="ac-member${m.revoked ? ' revoked' : ''}">
                <span class="ac-member-name">${esc(m.name)}</span>
                ${m.revoked
                    ? `<span class="badge muted">${esc(this.t('revoked'))}</span>`
                    : `<span class="badge online">${esc(this.t('active'))}</span>${manage
                        ? `<button class="btn btn-danger btn-sm" data-revoke="${esc(m.id)}" data-name="${esc(m.name)}">${esc(this.t('revoke'))}</button>`
                        : ''}`}
            </div>`).join('');
    },

    async addMember() {
        const input = this.$('ac-member-name');
        const name = input.value.trim();
        if (!name || !this.roomId) return;
        const roomId = this.roomId;
        const data = await this.api(`/rooms/${encodeURIComponent(roomId)}/members`, {
            method: 'POST', body: JSON.stringify({ name }),
        });
        if (!data) return;
        input.value = '';
        this.shownKey = { roomId, member: data.member, key: data.key };
        this.renderKey();
        await this.loadRooms();
    },

    renderKey() {
        const box = this.$('ac-keybox');
        if (!box) return;
        const sk = this.shownKey;
        if (!sk || sk.roomId !== this.roomId) {
            box.classList.add('hidden');
            box.innerHTML = '';
            return;
        }
        const url = window.location.origin + '/mcp/agentchat';
        const cmd = `claude mcp add --transport http --scope user agentchat ${url} --header "Authorization: Bearer ${sk.key}"`;
        box.innerHTML = `
            <div class="ac-keybox-title">${esc(this.t('key_for'))} ${esc(sk.member.name)}</div>
            <p class="ac-keybox-warn">${esc(this.t('key_once'))}</p>
            <label class="form-label">${esc(this.t('key'))}</label>
            <div class="ac-copy-row">
                <code class="mono ac-code">${esc(sk.key)}</code>
                <button class="btn btn-secondary btn-sm" data-copy="${esc(sk.key)}">${esc(this.t('copy'))}</button>
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
        setTimeout(() => { if (btn.isConnected) btn.textContent = this.t('copy'); }, 1500);
    },

    async revoke(memberId, name) {
        if (!this.roomId || !this.canManage()) return;
        if (!window.confirm(this.t('revoke_confirm') + ' ' + name)) return;
        const roomId = this.roomId;
        const data = await this.api(
            `/rooms/${encodeURIComponent(roomId)}/members/${encodeURIComponent(memberId)}/revoke`,
            { method: 'POST' });
        if (!data) return;
        await this.loadRooms();
    },
};
