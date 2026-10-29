/**
 * OmenServer — Agent Chat (vue SPA « Discussion », onglet de la top bar)
 *
 * Salon de coordination entre instances de Claude Code (serveur MCP
 * /mcp/agentchat). Cette vue sert à l'humain : lire le fil, écrire, éditer
 * le tableau ; l'admin crée aussi les salons et gère les clés des membres
 * (clé montrée une seule fois).
 *
 * Fonctionnalités : fil temps réel (polling), répondre à un message (citation
 * cliquable), pinger un agent (@Nom / @tous, pastilles « en attente / traité »),
 * joindre un document (bouton ou glisser-déposer, 25 Mo max, aperçu image,
 * téléchargement via Auth.apiCall car le JWT est dans un header).
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
    MAX_FILE: 25 * 1024 * 1024,
    msgById: {},         // index id -> message du fil chargé (vidé dans reloadFeed)
    pings: {},           // { nomMembre: [ids de pings ouverts] }
    _pingsKey: '',
    pingTimer: null,
    presenceTimer: null,
    presence: {},        // { memberId: vue de présence }
    replyTo: null,       // id du message auquel on répond
    pendingFile: null,   // File en attente d'envoi
    sending: false,
    _objectUrls: [],     // URLs blob à révoquer au unload()
    _io: null,

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
                    <div class="ac-replying hidden" id="ac-replying"></div>
                    <div class="ac-file-chip hidden" id="ac-file-chip"></div>
                    <form class="ac-compose" id="ac-compose">
                        <textarea class="form-input" id="ac-text" rows="2" maxlength="4000" placeholder="${t('compose_ph')}"></textarea>
                        <div class="ac-compose-actions">
                            <label class="ac-ping-wrap" for="ac-ping">${t('ping_label')}
                                <select class="form-input" id="ac-ping"></select>
                            </label>
                            <input type="file" id="ac-file" class="hidden" tabindex="-1">
                            <button class="btn btn-secondary btn-sm" type="button" id="ac-attach">${t('attach_btn')}</button>
                            <button class="btn btn-primary btn-sm" type="submit" id="ac-send">${t('send')}</button>
                        </div>
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
        if (this.pingTimer) clearInterval(this.pingTimer);
        this.pingTimer = null;
        if (this.presenceTimer) clearInterval(this.presenceTimer);
        this.presenceTimer = null;
        this.polling = false;
        this._feedRoom = null;
        this.gen++;
        if (this._io) { this._io.disconnect(); this._io = null; }
        this._objectUrls.forEach(u => { try { URL.revokeObjectURL(u); } catch (_) {} });
        this._objectUrls = [];
        this.msgById = {};
        this.pings = {};
        this._pingsKey = '';
        this.replyTo = null;
        this.pendingFile = null;
        this.sending = false;
    },

    alive(gen) { return gen === this.gen && !!this.$('ac-feed'); },

    // ---------------------------------------------------------------- events

    bind(manage) {
        this.$('ac-room-select').addEventListener('change', e => this.selectRoom(e.target.value));
        this.$('ac-compose').addEventListener('submit', e => { e.preventDefault(); this.send(); });
        this.$('ac-text').addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.send(); }
        });
        this.$('ac-compose').addEventListener('keydown', e => {
            if (e.key === 'Escape' && this.replyTo) { e.preventDefault(); this.cancelReply(); }
        });
        this.$('ac-attach').addEventListener('click', () => this.$('ac-file').click());
        this.$('ac-file').addEventListener('change', e => {
            const f = e.target.files && e.target.files[0];
            e.target.value = '';
            if (f) this.setFile(f);
        });
        this.$('ac-file-chip').addEventListener('click', e => {
            if (e.target.closest('[data-remove-file]')) this.setFile(null);
        });
        this.$('ac-replying').addEventListener('click', e => {
            if (e.target.closest('[data-cancel-reply]')) this.cancelReply();
        });
        this.$('ac-feed').addEventListener('click', e => {
            const rb = e.target.closest('[data-reply]');
            if (rb) { this.setReply(rb.dataset.reply); return; }
            const qb = e.target.closest('[data-quote]');
            if (qb) { this.jumpTo(qb.dataset.quote); return; }
            const db = e.target.closest('[data-file-id]');
            if (db && db.tagName === 'BUTTON') this.download(db.dataset.fileId, db.dataset.fileName, db);
        });
        const main = this.$('ac-feed').closest('.ac-main');
        const hasFiles = e => e.dataTransfer && Array.prototype.indexOf.call(e.dataTransfer.types || [], 'Files') >= 0;
        main.addEventListener('dragenter', e => { if (hasFiles(e)) { e.preventDefault(); main.classList.add('ac-dropping'); } });
        main.addEventListener('dragover', e => {
            if (hasFiles(e)) { e.preventDefault(); main.classList.add('ac-dropping'); }
        });
        main.addEventListener('dragleave', e => {
            if (!e.relatedTarget || !main.contains(e.relatedTarget)) main.classList.remove('ac-dropping');
        });
        main.addEventListener('drop', e => {
            if (!hasFiles(e)) return;
            e.preventDefault();
            main.classList.remove('ac-dropping');
            const f = e.dataTransfer.files && e.dataTransfer.files[0];
            if (f) this.setFile(f);
        });
        this.$('ac-board-save').addEventListener('click', () => this.saveBoard());
        this.$('ac-members').addEventListener('click', e => {
            const btn = e.target.closest('[data-revoke]');
            if (btn) { this.revoke(btn.dataset.revoke, btn.dataset.name); return; }
            const mb = e.target.closest('[data-mention]');
            if (mb) this.insertMention(mb.dataset.mention);
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

    fmtSize(n) {
        n = Number(n) || 0;
        const f = v => v.toLocaleString(undefined, { maximumFractionDigits: 1 });
        if (n < 1024) return n + ' ' + this.t('size_b');
        if (n < 1024 * 1024) return f(n / 1024) + ' ' + this.t('size_kb');
        return f(n / (1024 * 1024)) + ' ' + this.t('size_mb');
    },

    excerpt(text, max) {
        const s = String(text || '').replace(/\s+/g, ' ').trim();
        return s.length > max ? s.slice(0, max - 1) + '…' : s;
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
        this.msgById = {};
        this.pings = {};
        this.presence = {};
        this._pingsKey = '';
        this.cancelReply();
        this.$('ac-feed').innerHTML = '';
        if (this.pollTimer) clearInterval(this.pollTimer);
        if (this.pingTimer) clearInterval(this.pingTimer);
        if (this.presenceTimer) clearInterval(this.presenceTimer);
        this.polling = false;
        this.poll();
        this.refreshPresence();
        this.pollTimer = setInterval(() => { if (!document.hidden) this.poll(); }, this.POLL_MS);
        this.pingTimer = setInterval(() => { if (!document.hidden) this.refreshPings(); }, 20000);
        this.presenceTimer = setInterval(() => { if (!document.hidden) this.refreshPresence(); }, 10000);
    },

    async refreshPresence() {
        const roomAtStart = this.roomId;
        const gen = this.gen;
        if (!roomAtStart) return;
        try {
            const data = await this.api(`/rooms/${encodeURIComponent(roomAtStart)}/presence`);
            if (gen !== this.gen || roomAtStart !== this.roomId) return;
            const map = {};
            ((data && data.members) || []).forEach(v => { map[v.member_id] = v; });
            this.presence = map;
            this.renderMembers();
        } catch (_) { /* présence best-effort */ }
    },

    presenceHtml(m) {
        const v = this.presence[m.id];
        if (!v) return '';
        const badge = v.working
            ? `<span class="badge online">${esc(this.t('presence_working'))}</span>`
            : (v.online
                ? `<span class="badge">${esc(this.t('presence_idle'))}</span>`
                : `<span class="badge ac-off">${esc(this.t('presence_offline'))}</span>`);
        const n = v.sessions_working > 1
            ? `<span class="hint">${esc(this.t('sessions_working').replace('{n}', v.sessions_working))}</span>` : '';
        const fh = v.five_hour;
        let lim;
        if (fh && typeof fh.pct === 'number') {
            const pct = Math.max(0, Math.min(100, fh.pct));
            const cls = pct >= 90 ? 'danger' : (pct >= 75 ? 'warn' : '');
            let reset = '';
            if (fh.resets_at) {
                const d = new Date(fh.resets_at * 1000);
                const hhmm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                reset = `<span>${esc(this.t('limit_reset').replace('{t}', hhmm))}</span>`;
            }
            lim = `<span class="ac-limit"><span class="ac-bar"><span class="${cls}" style="width:${pct.toFixed(0)}%"></span></span>
                <span class="ac-limit-num ${cls}">${esc(this.t('limit_5h'))} ${esc(Math.round(pct))} %</span>${reset}</span>`;
        } else {
            lim = `<span class="ac-limit">${esc(this.t('limit_unknown'))}</span>`;
        }
        return `<div class="ac-presence">${badge}${n}${lim}</div>`;
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
            const added = this.appendMessages(data.messages || []);
            if (added) this.refreshPings();
        } finally {
            if (gen === this.gen) this.polling = false;
        }
    },

    /** Ajoute les nouveaux messages ; retourne le nombre de messages ajoutés. */
    appendMessages(msgs) {
        const feed = this.$('ac-feed');
        if (!feed) return 0;
        if (!msgs.length) {
            if (this.lastId === 0 && !feed.children.length) {
                feed.innerHTML = `<div class="ac-feed-empty">${esc(this.t('no_messages'))}</div>`;
            }
            return 0;
        }
        const fresh = msgs.filter(m => m.id > this.lastId);
        const empty = feed.querySelector('.ac-feed-empty');
        if (empty) empty.remove();
        const atBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 40 || this.lastId === 0;
        fresh.forEach(m => { this.msgById[m.id] = m; });  // index d'abord : les citations peuvent viser le même lot
        feed.insertAdjacentHTML('beforeend', fresh.map(m => this.renderMessage(m)).join(''));
        this.lastId = Math.max(this.lastId, ...msgs.map(m => m.id));
        this.observeThumbs();
        if (atBottom) feed.scrollTop = feed.scrollHeight;
        return fresh.length;
    },

    pingState(id, member) {
        const open = (this.pings[member] || []).map(String);
        return open.indexOf(String(id)) >= 0;
    },

    renderMessage(m) {
        const kind = String(m.kind || 'info');
        const cls = this.KIND_CLASS[kind] !== undefined ? this.KIND_CLASS[kind] : 'muted';
        const label = Lang.t('agentchat.kind.' + kind);
        let quote = '';
        if (m.reply_to) {
            const cited = this.msgById[m.reply_to];
            const body = cited
                ? `<span class="ac-quote-author">${esc(cited.author)}</span> <span class="ac-quote-text">${esc(this.excerpt(cited.text || (cited.attachment && cited.attachment.name) || '', 80))}</span>`
                : `<span class="ac-quote-text">${esc(this.t('reply_to'))} #${esc(m.reply_to)}</span>`;
            quote = `<button type="button" class="ac-quote" data-quote="${esc(m.reply_to)}">${body}</button>`;
        }
        const pings = (Array.isArray(m.mentions) ? m.mentions : []).map(name => {
            const pending = this.pingState(m.id, name);
            return `<span class="badge ac-ping-badge ${pending ? 'warn' : 'online'}" data-ping-id="${esc(m.id)}" data-ping-member="${esc(name)}">${esc(this.t('ping_arrow'))} ${esc(name)} · ${esc(this.t(pending ? 'ping_pending' : 'ping_done'))}</span>`;
        }).join('');
        const att = m.attachment ? this.renderAttachment(m.attachment) : '';
        const text = m.text ? `<div class="msg ac-msg-text">${esc(m.text)}</div>` : '';
        return `<div class="ev ac-msg ac-msg-${esc(kind)}" id="ac-m-${esc(m.id)}">
            <div class="ac-msg-head">
                <span class="ac-msg-id mono">#${esc(m.id)}</span>
                <span class="ac-msg-author">${esc(m.author)}</span>
                <span class="badge ${esc(cls)}">${esc(label)}</span>
                ${pings}
                <span class="ts ac-msg-ts mono">${esc(this.fmtTime(m.ts))}</span>
                <button type="button" class="btn btn-secondary btn-sm ac-reply-btn" data-reply="${esc(m.id)}">${esc(this.t('reply_btn'))}</button>
            </div>
            ${quote}
            ${text}
            ${att}
        </div>`;
    },

    renderAttachment(a) {
        const isImg = String(a.mime || '').indexOf('image/') === 0;
        const thumb = isImg
            ? `<img class="ac-attach-img" alt="${esc(a.name)}" data-thumb="${esc(a.id)}" loading="lazy">` : '';
        return `<div class="ac-attach">
            ${thumb}
            <div class="ac-attach-meta">
                <span class="ac-attach-name">${esc(a.name)}</span>
                <span class="ac-attach-info mono">${esc(this.fmtSize(a.size))} · ${esc(a.mime || '')}</span>
            </div>
            <button type="button" class="btn btn-secondary btn-sm" data-file-id="${esc(a.id)}" data-file-name="${esc(a.name)}">${esc(this.t('download'))}</button>
        </div>`;
    },

    // ---------------------------------------------------------------- réponses

    setReply(id) {
        const m = this.msgById[id];
        if (!m) return;
        this.replyTo = m.id;
        const box = this.$('ac-replying');
        box.innerHTML = `<span class="ac-replying-text">${esc(this.t('replying_to'))} #${esc(m.id)} — ${esc(m.author)} : ${esc(this.excerpt(m.text || (m.attachment && m.attachment.name) || '', 80))}</span>
            <button type="button" class="btn btn-secondary btn-sm" data-cancel-reply>${esc(this.t('cancel'))}</button>`;
        box.classList.remove('hidden');
        this.$('ac-text').focus();
    },

    cancelReply() {
        this.replyTo = null;
        const box = this.$('ac-replying');
        if (box) { box.classList.add('hidden'); box.innerHTML = ''; }
    },

    jumpTo(id) {
        const el = this.$('ac-m-' + id);
        if (!el) return;
        el.scrollIntoView({ block: 'center', behavior: 'smooth' });
        el.classList.add('ac-flash');
        setTimeout(() => el.classList.remove('ac-flash'), 1500);
    },

    // ---------------------------------------------------------------- pings

    /** Récupère les pings ouverts (silencieux) et met à jour pastilles + membres. */
    async refreshPings() {
        if (!this.roomId) return;
        const roomAtStart = this.roomId;
        const gen = this.gen;
        let data = null;
        try {
            const res = await Auth.apiCall(`${this.API}/rooms/${encodeURIComponent(roomAtStart)}/pings`);
            if (!res || !res.ok) return;
            data = await res.json();
        } catch (_) { return; }
        if (!data || roomAtStart !== this.roomId || !this.alive(gen)) return;
        const pings = data.pings && typeof data.pings === 'object' ? data.pings : {};
        const key = JSON.stringify(pings);
        if (key === this._pingsKey) return;
        this._pingsKey = key;
        this.pings = pings;
        this.updatePingBadges();
        this.renderMembers();
    },

    updatePingBadges() {
        const feed = this.$('ac-feed');
        if (!feed) return;
        feed.querySelectorAll('.ac-ping-badge').forEach(b => {
            const pending = this.pingState(b.dataset.pingId, b.dataset.pingMember);
            b.classList.toggle('warn', pending);
            b.classList.toggle('online', !pending);
            b.textContent = this.t('ping_arrow') + ' ' + b.dataset.pingMember + ' · ' + this.t(pending ? 'ping_pending' : 'ping_done');
        });
    },

    fillPingSelect() {
        const sel = this.$('ac-ping');
        if (!sel) return;
        const prev = sel.value;
        const room = this.currentRoom();
        const active = (room ? room.members : []).filter(m => !m.revoked);
        sel.innerHTML = `<option value="">${esc(this.t('ping_none'))}</option>`
            + active.map(m => `<option value="${esc(m.name)}">${esc(m.name)}</option>`).join('')
            + (active.length ? `<option value="__all__">${esc(this.t('ping_all'))}</option>` : '');
        if (Array.prototype.some.call(sel.options, o => o.value === prev)) sel.value = prev;
    },

    insertMention(name) {
        const ta = this.$('ac-text');
        if (!ta) return;
        const a = ta.selectionStart == null ? ta.value.length : ta.selectionStart;
        const b = ta.selectionEnd == null ? a : ta.selectionEnd;
        const before = ta.value.slice(0, a);
        const lead = before && !/\s$/.test(before) ? ' ' : '';
        const ins = lead + '@' + name + ' ';
        ta.value = before + ins + ta.value.slice(b);
        const pos = before.length + ins.length;
        ta.focus();
        ta.setSelectionRange(pos, pos);
    },

    // ---------------------------------------------------------------- fichiers

    setFile(file) {
        if (file && file.size > this.MAX_FILE) {
            this.showError(this.t('file_too_big'));
            return;
        }
        if (file) this.showError('');
        this.pendingFile = file || null;
        const chip = this.$('ac-file-chip');
        if (!chip) return;
        if (!file) { chip.classList.add('hidden'); chip.innerHTML = ''; return; }
        chip.innerHTML = `<span class="ac-file-chip-name mono">${esc(file.name)} (${esc(this.fmtSize(file.size))})</span>
            <button type="button" class="btn btn-secondary btn-sm" data-remove-file>${esc(this.t('attach_remove'))}</button>`;
        chip.classList.remove('hidden');
    },

    async fetchBlob(fileId) {
        const res = await Auth.apiCall(`${this.API}/rooms/${encodeURIComponent(this.roomId)}/files/${encodeURIComponent(fileId)}`);
        if (!res || !res.ok) return null;
        return res.blob();
    },

    async download(fileId, name, btn) {
        const gen = this.gen;
        btn.disabled = true;
        try {
            const blob = await this.fetchBlob(fileId);
            if (!this.alive(gen)) return;
            if (!blob) { this.showError(this.t('download_failed')); return; }
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = name || 'fichier';
            document.body.appendChild(a);
            a.click();
            a.remove();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
        } catch (_) {
            if (this.alive(gen)) this.showError(this.t('download_failed'));
        } finally {
            if (btn.isConnected) btn.disabled = false;
        }
    },

    /** Charge les miniatures d'images à l'approche de l'écran (ou tout de suite sans IntersectionObserver). */
    observeThumbs() {
        const feed = this.$('ac-feed');
        if (!feed) return;
        const imgs = feed.querySelectorAll('img[data-thumb]:not([data-seen])');
        if (!imgs.length) return;
        if (!this._io && 'IntersectionObserver' in window) {
            this._io = new IntersectionObserver(entries => {
                entries.forEach(en => {
                    if (en.isIntersecting) { this._io.unobserve(en.target); this.loadThumb(en.target); }
                });
            }, { root: feed, rootMargin: '200px' });
        }
        imgs.forEach(img => {
            img.dataset.seen = '1';
            if (this._io) this._io.observe(img); else this.loadThumb(img);
        });
    },

    async loadThumb(img) {
        const gen = this.gen;
        try {
            const blob = await this.fetchBlob(img.dataset.thumb);
            if (!blob || !this.alive(gen)) return;
            const url = URL.createObjectURL(blob);
            this._objectUrls.push(url);
            img.src = url;
        } catch (_) {}
    },

    setSending(on) {
        this.sending = on;
        const btn = this.$('ac-send');
        if (!btn) return;
        btn.disabled = on;
        btn.textContent = this.t(on ? 'sending' : 'send');
    },

    async send() {
        if (this.sending || !this.roomId) return;
        const ta = this.$('ac-text');
        let text = ta.value.trim();
        const file = this.pendingFile;
        if (!text && !file) return;
        if (file && file.size > this.MAX_FILE) { this.showError(this.t('file_too_big')); return; }
        const sel = this.$('ac-ping').value;
        const mentions = [];
        if (sel === '__all__') text = ('@tous ' + text).trim();
        else if (sel && file) text = ('@' + sel + ' ' + text).trim();   // l'upload n'a pas de champ mentions : le serveur lit @Nom
        else if (sel) mentions.push(sel);
        const room = encodeURIComponent(this.roomId);
        const gen = this.gen;
        this.setSending(true);
        try {
            let data;
            if (file) {
                const fd = new FormData();
                fd.append('file', file);
                fd.append('text', text);
                if (this.replyTo) fd.append('reply_to', String(this.replyTo));
                data = await this.api(`/rooms/${room}/files`, { method: 'POST', body: fd });
            } else {
                const body = { text };
                if (this.replyTo) body.reply_to = this.replyTo;
                if (mentions.length) body.mentions = mentions;
                data = await this.api(`/rooms/${room}/messages`, { method: 'POST', body: JSON.stringify(body) });
            }
            if (!data || !this.alive(gen)) return;
            ta.value = '';
            this.$('ac-ping').value = '';
            this.setFile(null);
            this.cancelReply();
            const feed = this.$('ac-feed');
            feed.scrollTop = feed.scrollHeight;
            this.poll();
        } finally {
            if (gen === this.gen) this.setSending(false); else this.sending = false;
        }
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
        this.fillPingSelect();
        const room = this.currentRoom();
        const members = room ? room.members : [];
        const manage = this.canManage();
        if (!members.length) {
            box.innerHTML = `<div class="hint ac-hint">${esc(this.t(manage ? 'no_members' : 'no_members_dev'))}</div>`;
            return;
        }
        box.innerHTML = members.map(m => `
            <div class="ac-member${m.revoked ? ' revoked' : ''}">
                ${m.revoked
                    ? `<span class="ac-member-name">${esc(m.name)}</span>`
                    : `<button type="button" class="ac-member-name ac-mention-btn" data-mention="${esc(m.name)}" title="${esc(this.t('mention_title'))}">${esc(m.name)}</button>`}
                ${(this.pings[m.name] || []).length
                    ? `<span class="badge warn">${esc(this.t('pings_open').replace('{n}', (this.pings[m.name] || []).length))}</span>` : ''}
                ${m.revoked
                    ? `<span class="badge muted">${esc(this.t('revoked'))}</span>`
                    : `<span class="badge online">${esc(this.t('active'))}</span>${manage
                        ? `<button class="btn btn-danger btn-sm" data-revoke="${esc(m.id)}" data-name="${esc(m.name)}">${esc(this.t('revoke'))}</button>`
                        : ''}`}
                ${m.revoked ? '' : this.presenceHtml(m)}
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
