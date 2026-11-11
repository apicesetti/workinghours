/**
 * Horas de trabajo — add-in de Geotab Drive (DriveAppLink/, onStartup).
 *
 * startup  corre al iniciar sesión en Drive y queda revisando cada N minutos si el chofer se
 *          identificó en un vehículo (DriverChange por llavero NFC o GO Focus). Si la jornada
 *          no tiene tripulación cargada, lanza una notificación nativa.
 * página   el chofer carga acompañantes, marca quién se bajó, asigna clientes a las paradas y
 *          cierra la jornada.
 *
 * Offline: todo lo cargado se guarda primero en localStorage y se sincroniza a AddInData
 * cuando vuelve la conexión. No hay recursos externos (Drive descarga todo al iniciar sesión).
 *
 * API de Drive usada (verificada en la guía de Drive Add-Ins de Geotab):
 *   api.call(method, params, success, error) · api.multiCall(calls, success, error)
 *   api.getSession(callback[, newSession:boolean])   ← el 2.º NO es callback de error
 *   api.mobile.notification.notify(message, title) → Promise
 *   api.mobile.notify(message, title, id)            (versiones anteriores)
 *   api.mobile.listenTo(callback)                     cambios de state (online, driving, …)
 *   state.online, state.device
 *
 * Ingeniero Jorge Cesetti SRL
 */
/* global geotab, WorkingHoursShared */
(function () {
'use strict';
var factory = function () {
    'use strict';

    var S = WorkingHoursShared;
    var esc = S.esc;
    var LS = 'wh.v1.';

    var api = null, state = null, root = null, store = null;
    var me = null;                 // { id, login, name }
    var settings = S.clone(S.DEFAULT_SETTINGS);
    var operators = [];            // [{ id, name }]
    var devices = {};              // id → nombre
    var zones = [];                // zonas compactas
    var jornadas = [];             // mis jornadas de ayer y hoy
    var records = {};              // key → registro (con _id y _dirty)
    var timelines = {};            // key → línea de tiempo (para paradas)
    var view = { name: 'home', key: null };
    var section = 'crew';          // 'crew' (Tripulación) | 'clients' (Clientes): pestaña del contenedor
    var checkin = null;            // { status: 'locating'|'ok'|'none', pos: { lat, lon, acc, src } }
    var timer = null, checking = null, listening = false;

    // ------------------------------------------------------------------
    // Utilidades
    // ------------------------------------------------------------------
    function lsGet(k, def) {
        try { var v = localStorage.getItem(LS + k); return v == null ? def : JSON.parse(v); } catch (e) { return def; }
    }
    function lsSet(k, v) { try { localStorage.setItem(LS + k, JSON.stringify(v)); } catch (e) { /* sin almacenamiento */ } }

    function call(method, params) {
        return new Promise(function (resolve, reject) { api.call(method, params, resolve, reject); });
    }
    function multiCall(calls) {
        if (!calls.length) { return Promise.resolve([]); }
        return new Promise(function (resolve, reject) { api.multiCall(calls, resolve, reject); });
    }
    function isOnline() { return !state || state.online !== false; }
    function today() { return S.dayKey(Date.now()); }
    function $(sel) { return root && root.querySelector(sel); }
    function by() { return me ? me.login : ''; }

    /** Texto legible de un error del API de Geotab (varía según la versión de Drive). */
    function errText(e) {
        if (!e) { return 'Error desconocido'; }
        if (typeof e === 'string') { return e; }
        var inner = (e.errors && e.errors[0]) || (e.error && e.error.errors && e.error.errors[0]) || e.error || {};
        var name = inner.name || e.name || (e.data && e.data.type) || '';
        var msg = inner.message || e.message || '';
        if (!msg) { try { msg = JSON.stringify(e).slice(0, 200); } catch (x) { msg = String(e); } }
        return (name && msg.indexOf(name) < 0 ? name + ': ' : '') + msg;
    }

    function showMsg(text, kind) {
        var el = $('#whd-msg');
        if (!el) { return; }
        el.textContent = text;
        el.className = 'whd-msg whd-msg-' + (kind || 'info');
        el.hidden = false;
        clearTimeout(showMsg.t);
        showMsg.t = setTimeout(function () { el.hidden = true; }, kind === 'error' ? 9000 : 4000);
    }

    // ------------------------------------------------------------------
    // Caché local
    // ------------------------------------------------------------------
    function loadCache() {
        me = lsGet('me', null);
        settings = Object.assign(S.clone(S.DEFAULT_SETTINGS), lsGet('settings', {}));
        operators = lsGet('operators', []);
        devices = lsGet('devices', {});
        zones = lsGet('zones', { list: [] }).list || [];
        jornadas = lsGet('jornadas', []);
        records = lsGet('records', {});
    }

    function saveRecordsLocal() {
        // conserva solo ayer/hoy y lo pendiente de sincronizar
        var keep = {}, min = S.addDays(today(), -1);
        Object.keys(records).forEach(function (k) {
            var r = records[k];
            if (r && (r._dirty || r.date >= min)) { keep[k] = r; }
        });
        records = keep;
        lsSet('records', records);
    }

    function pendingSync() {
        return Object.keys(records).filter(function (k) { return records[k] && records[k]._dirty; }).length;
    }

    // ------------------------------------------------------------------
    // Datos del servidor
    // ------------------------------------------------------------------
    function loadMe() {
        return new Promise(function (resolve) {
            try {
                api.getSession(function (s) { resolve(s && s.userName ? s.userName : ''); });
            } catch (e) { resolve(''); }
        }).then(function (login) {
            if (!login) { return me; }
            if (me && me.login === login && me.id) { return me; }
            return call('Get', { typeName: 'User', search: { name: login } }).then(function (list) {
                var u = (list || [])[0];
                if (u) { me = { id: u.id, login: u.name, name: S.userName(u) }; lsSet('me', me); }
                return me;
            });
        });
    }

    function loadSettings() {
        return store.settings().then(function (s) { settings = s; lsSet('settings', s); });
    }

    function loadOperators() {
        if (lsGet('operatorsAt', 0) > Date.now() - 6 * 3600000 && operators.length) { return Promise.resolve(); }
        return multiCall([
            ['Get', { typeName: 'User', search: { isDriver: true } }],
            ['Get', { typeName: 'Group' }]
        ]).then(function (r) {
            operators = S.operatorsFrom(r[0], r[1], settings);
            lsSet('operators', operators);
            lsSet('operatorsAt', Date.now());
        }).catch(function () {
            // perfil sin permiso para listar usuarios/grupos: se usa la lista de conductores de Drive
            if (!(api.mobile && api.mobile.user && api.mobile.user.get)) { return; }
            return Promise.resolve(api.mobile.user.get(true)).then(function (list) {
                operators = S.operatorsFrom(list || [], [], settings);
                lsSet('operators', operators);
                lsSet('operatorsAt', Date.now());
            }).catch(function () { /* se mantiene la caché */ });
        });
    }

    function loadZones() {
        var cached = lsGet('zones', null);
        if (cached && cached.at > Date.now() - 24 * 3600000) { zones = cached.list || []; return Promise.resolve(); }
        return call('Get', {
            typeName: 'Zone',
            propertySelector: { fields: ['id', 'name', 'zoneTypes', 'points', 'activeTo'], isIncluded: true }
        }).then(function (list) {
            zones = (list || []).filter(function (z) { return S.isActive(z); }).map(S.compactZone);
            lsSet('zones', { at: Date.now(), list: zones });
        }).catch(function () { /* sin zonas: no hay sugerencias, se carga a mano */ });
    }

    function loadDeviceNames(ids) {
        var missing = ids.filter(function (id) { return !devices[id]; });
        if (!missing.length) { return Promise.resolve(); }
        return multiCall(missing.map(function (id) {
            return ['Get', { typeName: 'Device', search: { id: id }, propertySelector: { fields: ['id', 'name', 'licensePlate'], isIncluded: true } }];
        })).then(function (res) {
            (res || []).forEach(function (list) {
                var d = (list || [])[0];
                if (d) { devices[d.id] = d.name + (d.licensePlate && d.licensePlate !== d.name ? ' · ' + d.licensePlate : ''); }
            });
            lsSet('devices', devices);
        }).catch(function () { /* se muestra el id */ });
    }

    /** Mis identificaciones de ayer y hoy → jornadas; trae sus registros. */
    function check(opts) {
        opts = opts || {};
        if (checking) { return checking; }
        if (!isOnline()) { return Promise.resolve(false); }
        var from = S.dayStart(S.addDays(today(), -1));
        checking = loadMe().then(function () {
            if (!me) { throw new Error('No se pudo identificar al usuario de Drive.'); }
            var first = opts.full ? Promise.all([loadSettings(), flush()]) : flush();
            return first;
        }).then(function () {
            return call('Get', {
                typeName: 'DriverChange',
                search: { userSearch: { id: me.id }, fromDate: S.iso(from), toDate: S.iso(Date.now()) }
            });
        }).then(function (changes) {
            jornadas = S.buildJornadas(changes, { now: Date.now() }).filter(function (j) { return j.driverId === me.id; });
            lsSet('jornadas', jornadas);
            return store.recordsByDates([S.addDays(today(), -1), today()]);
        }).then(function (recs) {
            recs.forEach(function (r) {
                var local = records[r.key];
                if (local && local._dirty) { local._id = local._id || r._id; return; }   // gana lo local sin sincronizar
                records[r.key] = r;
            });
            saveRecordsLocal();
            lsSet('checkedAt', Date.now());
            var ids = [];
            jornadas.forEach(function (j) { S.deviceIdsOf(j).forEach(function (d) { if (ids.indexOf(d) < 0) { ids.push(d); } }); });
            return loadDeviceNames(ids);
        }).then(function () {
            notifyPending();       // después de los nombres, para que el aviso diga en qué vehículo
        }).then(function () {
            return opts.full ? Promise.all([loadOperators(), loadZones()]) : null;
        }).then(function () { return true; }).finally(function () { checking = null; });
        return checking;
    }

    // ------------------------------------------------------------------
    // Sincronización
    // ------------------------------------------------------------------
    function flush() {
        if (!isOnline()) { return Promise.resolve(); }
        var keys = Object.keys(records).filter(function (k) { return records[k] && records[k]._dirty; });
        var lastError = null;
        return keys.reduce(function (p, k) {
            return p.then(function () {
                return store.save(records[k]).then(function (saved) {
                    // si hubo otra edición local mientras se guardaba, se vuelve a marcar
                    if (records[k] && records[k].updatedAt !== saved.updatedAt) { records[k]._id = saved._id; return; }
                    records[k] = saved;
                }).catch(function (e) {
                    // queda pendiente; se guarda el motivo para mostrarlo
                    lastError = { at: Date.now(), text: errText(e) };
                    try { console.error('Horas de trabajo: no se pudo sincronizar', k, e); } catch (x) { /* sin consola */ }
                });
            });
        }, Promise.resolve()).then(function () {
            lsSet('syncError', pendingSync() ? lastError : null);
            saveRecordsLocal();
            renderSync();
        });
    }

    function saveLocal(rec, action, detail) {
        S.addHistory(rec, by(), action, detail);
        rec._dirty = true;
        records[rec.key] = rec;
        saveRecordsLocal();
        renderSync();
        return flush().then(function () {
            var pending = records[rec.key] && records[rec.key]._dirty;
            if (!pending) { showMsg('Guardado.', 'ok'); }
            else if (!isOnline()) { showMsg('Guardado en el teléfono. Se sincroniza cuando haya señal.', 'ok'); }
            else { showMsg('Guardado en el teléfono, pero MyGeotab lo rechazó. Mirá el motivo arriba.', 'error'); }
        });
    }

    // ------------------------------------------------------------------
    // Notificaciones
    // ------------------------------------------------------------------
    function notify(title, message) {
        try {
            var m = api && api.mobile;
            if (m && m.notification && typeof m.notification.notify === 'function') {
                return Promise.resolve(m.notification.notify(message, title)).catch(function () { /* permiso denegado */ });
            }
            if (m && typeof m.notify === 'function') { m.notify(message, title, 'wh' + Date.now()); }
        } catch (e) { /* fuera de la app nativa */ }
        return Promise.resolve();
    }

    function allRecords() { return Object.keys(records).map(function (k) { return records[k]; }).filter(Boolean); }
    function myInvites() { return me ? S.invitesFor(me.id, allRecords()).filter(function (i) { return i.crew.date >= S.addDays(today(), -1); }) : []; }
    function myClaimsToResolve() { return me ? S.claimsFor(me.id, allRecords()) : []; }
    function pendingActions() {
        var n = myInvites().length + myClaimsToResolve().length;
        jornadas.forEach(function (j) { if (j.date === today() && !S.hasCrew(records[j.key])) { n++; } });
        return n;
    }
    var APP = window.CESETTI_SHELL ? 'Mi jornada → Tripulación' : 'Horas de trabajo';

    function notifyPending() {
        var notified = lsGet('notified', {});
        var day = today();
        jornadas.forEach(function (j) {
            if (j.date !== day || notified[j.key] || S.hasCrew(records[j.key])) { return; }
            notified[j.key] = Date.now();
            var veh = devices[j.deviceId] || 'un vehículo';
            notify('¿Quién viaja con vos?',
                'Te identificaste en ' + veh + ' a las ' + S.hhmm(j.firstAt) + '. Abrí ' + APP + ' y cargá tus acompañantes.');
        });
        // me cargaron como acompañante: confirmar
        myInvites().forEach(function (i) {
            var k = 'inv|' + i.crew.key + '|' + i.member.from;
            if (notified[k]) { return; }
            notified[k] = Date.now();
            notify('¿Viajás con ' + (i.crew.driverName || 'otro chofer') + '?',
                (i.crew.driverName || 'Un chofer') + ' te cargó como acompañante' + (i.crew.deviceName ? ' en ' + i.crew.deviceName : '')
                + ' desde las ' + S.hhmm(i.member.from) + '. Abrí ' + APP + ' y confirmá.');
        });
        // alguien dice que viaja conmigo: confirmar o rechazar
        myClaimsToResolve().forEach(function (c) {
            var k = 'clm|' + c.key;
            if (notified[k]) { return; }
            notified[k] = Date.now();
            notify(c.name + ' dice que viaja con vos', 'Desde las ' + S.hhmm(c.at) + '. Abrí ' + APP + ' para confirmarlo.');
        });
        // limpieza: solo se recuerdan las de los últimos 3 días
        var min = S.addDays(day, -3);
        Object.keys(notified).forEach(function (k) { if (notified[k] < Date.now() - 3 * S.DAY) { delete notified[k]; } });
        lsSet('notified', notified);
    }

    function startLoop() {
        if (timer) { return; }
        var every = Math.max(1, settings.pollMinutes || 2) * 60000;
        timer = setInterval(function () {
            check().then(function () {
                if (root && view.name === 'home') { render(); }
                if (root && view.name === 'clients') { loadClientTimelines().then(function () { if (view.name === 'clients') { render(); } }); }
            }).catch(function () { /* reintenta */ });
        }, every);
        if (!listening && api && api.mobile && typeof api.mobile.listenTo === 'function') {
            listening = true;
            try {
                api.mobile.listenTo(function (s) {
                    var wasOffline = state && state.online === false;
                    if (s) { state = s; }
                    if (wasOffline && isOnline()) { check().then(render).catch(function () {}); }
                });
            } catch (e) { listening = false; }
        }
    }

    // ------------------------------------------------------------------
    // Vista: inicio
    // ------------------------------------------------------------------
    function recordFor(j) {
        var r = records[j.key];
        if (!r) {
            r = S.newCrewRecord(j, { deviceName: vehiclesOf(j), driverName: me ? me.name : '', by: by(), source: 'drive' });
        }
        return r;
    }

    function memberNames(rec) {
        return S.activeMembers(rec).map(function (m) { return m.name; });
    }

    function renderSync() {
        var el = $('#whd-sync');
        if (!el) { return; }
        var n = pendingSync();
        var parts = [];
        if (!isOnline()) { parts.push('Sin conexión'); }
        if (n) { parts.push(n === 1 ? '1 cambio sin sincronizar' : n + ' cambios sin sincronizar'); }
        var err = n && isOnline() ? lsGet('syncError', null) : null;
        el.innerHTML = '<span>' + esc(parts.join(' · ')) + '</span>'
            + (err ? '<small class="whd-sync-err">' + esc(S.hhmm(err.at) + ' · ' + err.text) + '</small>' : '')
            + (n && isOnline() ? '<button class="whd-btn whd-btn-sm whd-btn-ghost" data-act="retry">Reintentar</button>' : '');
        el.hidden = !parts.length;
    }

    function renderAsks() {
        var html = '';
        myInvites().forEach(function (i) {
            html += '<article class="whd-card whd-card-ask">'
                + '<h2>¿Viajás con ' + esc(i.crew.driverName || 'este chofer') + '?</h2>'
                + '<p class="whd-sub">Te cargó como acompañante' + (i.crew.deviceName ? ' en <b>' + esc(i.crew.deviceName) + '</b>' : '')
                + ' desde las ' + S.hhmm(i.member.from) + (i.crew.date !== today() ? ' (ayer)' : '') + '.</p>'
                + '<div class="whd-actions">'
                + '<button class="whd-btn" data-act="ack" data-key="' + esc(i.crew.key) + '" data-status="ok">Sí, viajo</button>'
                + '<button class="whd-btn whd-btn-ghost" data-act="ack" data-key="' + esc(i.crew.key) + '" data-status="no">No viajo</button>'
                + '</div></article>';
        });
        myClaimsToResolve().forEach(function (c) {
            html += '<article class="whd-card whd-card-ask">'
                + '<h2>' + esc(c.name) + ' dice que viaja con vos</h2>'
                + '<p class="whd-sub">Desde las ' + S.hhmm(c.at) + (c.date !== today() ? ' (ayer)' : '') + '. Si es así, se suma a tu tripulación.</p>'
                + '<div class="whd-actions">'
                + '<button class="whd-btn" data-act="claimOk" data-key="' + esc(c.key) + '">Confirmar</button>'
                + '<button class="whd-btn whd-btn-ghost" data-act="claimNo" data-key="' + esc(c.key) + '">No viaja conmigo</button>'
                + '</div></article>';
        });
        return html;
    }

    function renderMyClaims() {
        if (!me) { return ''; }
        var mine = S.claimsBy(me.id, allRecords()).filter(function (c) { return c.date === today(); }).slice(0, 3);
        if (!mine.length) { return ''; }
        var txt = { pending: 'esperando que confirme', accepted: 'confirmado', rejected: 'dijo que no viajás con él' };
        return '<article class="whd-card"><h2>Viajes que declaraste</h2><ul class="whd-list">' + mine.map(function (c) {
            return '<li><span>Con ' + esc(c.driverName) + '<small>desde las ' + S.hhmm(c.at) + '</small></span>'
                + '<span class="whd-pill ' + (c.status === 'accepted' ? 'whd-pill-ok' : c.status === 'rejected' ? 'whd-pill-warn' : '') + '">' + txt[c.status] + '</span></li>';
        }).join('') + '</ul></article>';
    }

    function claimButton() {
        return (window.CESETTI_SHELL ? '' : '<div class="whd-claim"><button class="whd-btn whd-btn-ghost" data-act="sec" data-key="clients">Clientes ›</button></div>')
            + '<div class="whd-claim"><button class="whd-btn whd-btn-ghost" data-act="claimStart">¿Viajás de acompañante? Viajo con…</button></div>';
    }

    function renderHome() {
        var day = today();
        var list = jornadas.slice().sort(function (a, b) { return b.firstAt - a.firstAt; });
        var asks = renderAsks();
        if (!list.length) {
            return asks + renderMyClaims() + '<div class="whd-empty"><p><b>Sin identificaciones hoy.</b></p>'
                + '<p>Cuando pases el llavero o la cámara te identifique en un vehículo, te vamos a avisar para que cargues quién viaja con vos.</p></div>'
                + claimButton();
        }
        return asks + list.map(function (j) {
            var rec = records[j.key];
            var names = memberNames(rec);
            var crew;
            if (!S.hasCrew(rec)) { crew = '<span class="whd-pill whd-pill-warn">Falta cargar acompañantes</span>'; }
            else if (rec.solo && !names.length) { crew = '<span class="whd-pill">Viajó solo</span>'; }
            else { crew = '<span class="whd-pill whd-pill-ok">' + esc(names.join(', ') || 'Sin acompañantes ahora') + '</span>'; }
            var issues = rec ? S.crewIssues(rec, allRecords()) : [];
            if (issues.length) { crew += ' ' + issues.map(function (x) { return '<span class="whd-pill whd-pill-warn">' + esc(x.text) + '</span>'; }).join(' '); }
            var confirmed = rec && rec.planilla;
            var dayLbl = j.date === day ? 'Hoy' : 'Ayer';
            return '<article class="whd-card">'
                + '<div class="whd-card-head"><div><h2>' + esc(vehiclesOf(j)) + '</h2>'
                + '<p class="whd-sub">' + dayLbl + ' · identificado a las ' + S.hhmm(j.firstAt) + '</p></div></div>'
                + '<div class="whd-crew">' + crew
                + (confirmed ? ' <span class="whd-pill whd-pill-ok">Planilla confirmada</span>' : '') + '</div>'
                + '<div class="whd-actions">'
                + '<button class="whd-btn" data-act="crew" data-key="' + esc(j.key) + '">' + (S.hasCrew(rec) ? 'Tripulación' : 'Cargar acompañantes') + '</button>'
                + (window.CESETTI_SHELL ? '' : '<button class="whd-btn whd-btn-ghost" data-act="stops" data-key="' + esc(j.key) + '">Paradas y clientes</button>')
                + '<button class="whd-btn whd-btn-ghost" data-act="sheet" data-key="' + esc(j.key) + '">Planilla</button>'
                + '</div></article>';
        }).join('') + renderMyClaims() + claimButton();
    }

    // ------------------------------------------------------------------
    // Vista: tripulación
    // ------------------------------------------------------------------
    var picked = {};

    function freqOrder(list) {
        var freq = lsGet('freq', {});
        return list.slice().sort(function (a, b) {
            return (freq[b.id] || 0) - (freq[a.id] || 0) || a.name.localeCompare(b.name, 'es');
        });
    }

    function renderCrew() {
        var j = findJornada(view.key);
        if (!j) { return '<p class="whd-empty">Jornada no encontrada.</p>'; }
        var rec = recordFor(j);
        var current = S.activeMembers(rec);
        var currentIds = {};
        current.forEach(function (m) { currentIds[m.userId] = true; });
        var first = !S.hasCrew(rec);
        var filter = ($('#whd-search') && $('#whd-search').value || '').toLowerCase();

        var html = '<button class="whd-back" data-act="home">‹ Volver</button>'
            + '<h2 class="whd-title">' + esc(vehiclesOf(j)) + '</h2>'
            + '<p class="whd-sub">Identificado a las ' + S.hhmm(j.firstAt) + '</p>';

        if (current.length) {
            html += '<h3>Viajan con vos</h3><ul class="whd-list">' + current.map(function (m) {
                return '<li><span>' + esc(m.name) + '<small>desde las ' + S.hhmm(m.from) + '</small></span>'
                    + '<button class="whd-btn whd-btn-sm whd-btn-ghost" data-act="drop" data-user="' + esc(m.userId) + '">Se bajó</button></li>';
            }).join('') + '</ul>';
        }

        var candidates = freqOrder(operators.filter(function (o) {
            return o.id !== (me && me.id) && !currentIds[o.id]
                && (!filter || o.name.toLowerCase().indexOf(filter) >= 0 || (o.employeeNo || '').indexOf(filter) >= 0);
        }));
        var nPicked = Object.keys(picked).length;
        html += '<h3>' + (current.length ? 'Sumar acompañantes' : '¿Quién viaja con vos?') + '</h3>'
            + '<p class="whd-hint">' + (first
                ? 'Se cuentan desde que te identificaste (' + S.hhmm(j.firstAt) + ').'
                : 'Se cuentan desde ahora (' + S.hhmm(Date.now()) + ').') + '</p>'
            + '<input id="whd-search" class="whd-input" type="search" placeholder="Buscar por nombre o legajo" value="' + esc(filter) + '" autocomplete="off">'
            + (operators.length ? '' : '<p class="whd-hint">No hay lista de operarios en el teléfono. Conectate a internet y tocá ↻.</p>')
            + '<ul class="whd-list whd-pick">' + candidates.slice(0, 80).map(function (o) {
                var on = !!picked[o.id];
                return '<li><label class="whd-check' + (on ? ' is-on' : '') + '"><input type="checkbox" data-pick="' + esc(o.id) + '"' + (on ? ' checked' : '') + '>'
                    + '<span>' + esc(o.name) + (o.employeeNo ? '<small>Legajo ' + esc(o.employeeNo) + '</small>' : '') + '</span></label></li>';
            }).join('') + '</ul>'
            + '<div class="whd-bar">'
            + '<button class="whd-btn" data-act="saveCrew"' + (nPicked ? '' : ' disabled') + '>Guardar' + (nPicked ? ' (' + nPicked + ')' : '') + '</button>'
            + (current.length ? '' : '<button class="whd-btn whd-btn-ghost" data-act="solo">Viajo solo</button>')
            + '</div>';
        return html;
    }

    function saveCrew() {
        var j = findJornada(view.key);
        var ids = Object.keys(picked);
        if (!j || !ids.length) { return; }
        var rec = S.clone(recordFor(j));
        var from = S.hasCrew(rec) ? S.iso(Date.now()) : S.iso(j.firstAt);
        var freq = lsGet('freq', {});
        ids.forEach(function (id) {
            var o = operators.filter(function (x) { return x.id === id; })[0] || { id: id, name: id };
            rec.members.push({ userId: id, name: o.name, from: from, to: null, addedBy: by(), addedAt: S.iso(Date.now()) });
            freq[id] = (freq[id] || 0) + 1;
        });
        lsSet('freq', freq);
        rec.solo = false;
        picked = {};
        saveLocal(rec, 'members', ids.length + ' acompañante(s)').then(render);
        view = { name: 'home', key: null };
        render();
    }

    function saveSolo() {
        var j = findJornada(view.key);
        if (!j) { return; }
        var rec = S.clone(recordFor(j));
        rec.solo = true;
        saveLocal(rec, 'solo', '').then(render);
        view = { name: 'home', key: null };
        render();
    }

    function dropMember(userId) {
        var j = findJornada(view.key);
        if (!j) { return; }
        var rec = S.clone(recordFor(j));
        var name = '';
        rec.members.forEach(function (m) { if (m.userId === userId && !m.to) { m.to = S.iso(Date.now()); name = m.name; } });
        saveLocal(rec, 'drop', name).then(render);
        render();
    }

    // ------------------------------------------------------------------
    // Confirmación de acompañante y "viajo con…"
    // ------------------------------------------------------------------
    function renderClaim() {
        var filter = ($('#whd-search') && $('#whd-search').value || '').toLowerCase();
        var norm = function (t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); };
        var f = norm(filter);
        // primero los choferes con tripulación cargada hoy (se muestra el vehículo)
        var vehOf = {};
        allRecords().forEach(function (r) {
            if (r.type === S.CREW && r.date === today() && r.deviceName) { vehOf[r.driverId] = r.deviceName; }
        });
        var list = operators.filter(function (o) {
            return o.id !== (me && me.id) && (!f || norm(o.name).indexOf(f) >= 0 || (o.employeeNo || '').indexOf(f) >= 0);
        }).sort(function (a, b) {
            return (vehOf[b.id] ? 1 : 0) - (vehOf[a.id] ? 1 : 0) || a.name.localeCompare(b.name, 'es');
        });
        return '<button class="whd-back" data-act="home">‹ Volver</button>'
            + '<h2 class="whd-title">¿Con quién viajás?</h2>'
            + '<p class="whd-hint">Elegí al chofer. Le llega un aviso para que lo confirme. Se cuenta desde ahora (' + S.hhmm(Date.now()) + ').</p>'
            + '<input id="whd-search" class="whd-input" type="search" placeholder="Buscar chofer por nombre o legajo" value="' + esc(filter) + '" autocomplete="off">'
            + (operators.length ? '' : '<p class="whd-hint">No hay lista de choferes en el teléfono. Conectate a internet y tocá ↻.</p>')
            + '<ul class="whd-list whd-pick">' + list.slice(0, 60).map(function (o) {
                return '<li><button class="whd-user" data-act="claimSave" data-user="' + esc(o.id) + '"><span>' + esc(o.name)
                    + (vehOf[o.id] ? '<small>' + esc(vehOf[o.id]) + '</small>' : (o.employeeNo ? '<small>Legajo ' + esc(o.employeeNo) + '</small>' : ''))
                    + '</span></button></li>';
            }).join('') + '</ul>';
    }

    function saveAck(crewKey, status) {
        var crew = records[crewKey];
        if (!crew || !me) { return; }
        var rec = S.newAck(crew, me, status, by());
        if (records[rec.key] && records[rec.key]._id) { rec._id = records[rec.key]._id; }
        saveLocal(rec, 'ack', status).then(render);
        render();
    }

    function saveClaim(driverId) {
        var o = operators.filter(function (x) { return x.id === driverId; })[0];
        if (!o || !me) { return; }
        var rec = S.newClaim(me, o, { by: by() });
        saveLocal(rec, 'claim', o.name).then(render);
        view = { name: 'home', key: null };
        render();
    }

    function resolveClaim(key, accept) {
        var c = records[key];
        if (!c) { return; }
        var claim = S.clone(c);
        claim.status = accept ? 'accepted' : 'rejected';
        claim.resolvedAt = S.iso(Date.now());
        claim.resolvedBy = by();
        if (accept) {
            var j = S.jornadaForClaim(jornadas, claim);
            if (!j) { showMsg('No tenés una identificación ese día: no se puede sumar a ' + claim.name + '.', 'error'); return; }
            var rec = S.clone(recordFor(j));
            var already = (rec.members || []).some(function (m) { return m.userId === claim.userId && !m.to; });
            if (!already) {
                var from = Math.max(S.toMs(claim.at), j.firstAt);
                rec.members.push({ userId: claim.userId, name: claim.name, from: S.iso(from), to: null, addedBy: by(), addedAt: S.iso(Date.now()), viaClaim: claim.key });
                rec.solo = false;
            }
            claim.crewKey = rec.key;
            S.addHistory(rec, by(), 'claim', claim.name);
            rec._dirty = true;
            records[rec.key] = rec;
        }
        saveLocal(claim, accept ? 'accept' : 'reject', '').then(render);
        render();
    }

    // ------------------------------------------------------------------
    // Clientes: llegada (check-in), visitas del día y tramos entre clientes
    // ------------------------------------------------------------------
    /** Jornadas de hoy en las que estoy: las mías como chofer y las de otros como acompañante. */
    function todayJornadas() {
        var day = today();
        var list = jornadas.filter(function (j) { return j.date === day; }).map(function (j) { return { j: j, role: 'driver' }; });
        allRecords().forEach(function (r) {
            if (r.type !== S.CREW || r.date !== day || !me || r.driverId === me.id) { return; }
            var m = (r.members || []).filter(function (x) { return x.userId === me.id; })[0];
            if (!m || S.memberStatus(r, m, S.ackIndex(allRecords())) === 'no') { return; }
            list.push({ role: 'companion', member: m, j: { key: r.key, date: r.date, driverId: r.driverId, deviceId: r.deviceId,
                deviceIds: r.deviceIds, firstAt: S.toMs(r.identifiedAt), segments: [] } });
        });
        return list;
    }

    function loadClientTimelines() {
        return Promise.all(todayJornadas().map(function (x) {
            return loadTimeline(x.j).catch(function () { return null; });
        }));
    }

    function myVehicle() {
        var tj = todayJornadas().sort(function (a, b) { return b.j.firstAt - a.j.firstAt; })[0];
        var sd = state && S.idOf(state.device);
        if (sd && sd !== 'NoDeviceId') { return { deviceId: sd, jornadaKey: tj ? tj.j.key : null }; }
        return tj ? { deviceId: tj.j.deviceId, jornadaKey: tj.j.key } : { deviceId: null, jornadaKey: null };
    }

    /** Posición del teléfono; si no hay, la del vehículo (DeviceStatusInfo). */
    function locate() {
        var geo = (api && api.mobile && api.mobile.geolocation) || (typeof navigator !== 'undefined' && navigator.geolocation);
        var phone = new Promise(function (resolve) {
            if (!geo || typeof geo.getCurrentPosition !== 'function') { resolve(null); return; }
            var t = setTimeout(function () { resolve(null); }, 20000);
            try {
                geo.getCurrentPosition(function (p) {
                    clearTimeout(t);
                    resolve({ lat: p.coords.latitude, lon: p.coords.longitude, acc: p.coords.accuracy, src: 'phone' });
                }, function () { clearTimeout(t); resolve(null); }, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 });
            } catch (e) { clearTimeout(t); resolve(null); }
        });
        return phone.then(function (pos) {
            if (pos && (pos.acc == null || pos.acc <= 200)) { return pos; }
            var dev = myVehicle().deviceId;
            if (!dev || !isOnline()) { return pos; }
            return call('Get', { typeName: 'DeviceStatusInfo', search: { deviceSearch: { id: dev } } }).then(function (l) {
                var d = (l || [])[0];
                return d && d.latitude != null ? { lat: d.latitude, lon: d.longitude, acc: null, src: 'vehicle' } : pos;
            }).catch(function () { return pos; });
        });
    }

    function startCheckin() {
        checkin = { status: 'locating', pos: null };
        go('checkin');
        locate().then(function (pos) {
            if (!checkin) { return; }
            checkin.pos = pos;
            checkin.status = pos ? 'ok' : 'none';
            if (view.name === 'checkin') { render(); }
        });
    }

    function clientCatalog() {
        var seen = {}, out = [];
        function add(n, z) { var k = String(n || '').trim().toLowerCase(); if (k && !seen[k]) { seen[k] = true; out.push({ name: String(n).trim(), zoneId: z || null }); } }
        lsGet('recentClients', []).forEach(function (c) { add(c); });
        (settings.clients || []).forEach(function (c) { add(c); });
        var types = {};
        (settings.clientZoneTypeIds || []).forEach(function (t) { types[t] = true; });
        var base = {};
        (settings.baseZoneIds || []).forEach(function (id) { base[id] = true; });
        zones.forEach(function (z) {
            if (base[z.id]) { return; }
            if ((settings.clientZoneTypeIds || []).length && !z.types.some(function (t) { return types[t]; })) { return; }
            add(z.name, z.id);
        });
        return out;
    }

    function renderCheckin() {
        var c = checkin || { status: 'none' };
        var q = ($('#whd-search') && $('#whd-search').value || '').trim();
        var norm = function (t) { return String(t || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, ''); };
        var nq = norm(q);
        var pos = c.pos;
        var point = pos ? { x: pos.lon, y: pos.lat } : null;
        var near = point ? S.nearbyZones(point, zones, settings).slice(0, 6) : [];
        var posTxt = c.status === 'locating' ? 'Buscando tu ubicación…'
            : !pos ? 'No se pudo obtener la ubicación (ni del teléfono ni del vehículo). Se guarda la llegada igual, sin geocerca.'
                : (pos.src === 'phone' ? 'Ubicación del teléfono' + (pos.acc != null ? ' (±' + Math.round(pos.acc) + ' m)' : '') : 'Ubicación del vehículo (el teléfono no dio posición)');
        var html = '<button class="whd-back" data-act="home">‹ Volver</button>'
            + '<h2 class="whd-title">¿En qué cliente estás?</h2>'
            + '<p class="whd-hint">' + esc(posTxt) + '</p>';
        if (near.length && !q) {
            html += '<h3>Cerca de acá</h3><ul class="whd-list whd-pick">' + near.map(function (r) {
                return '<li><button class="whd-user" data-act="checkinSave" data-name="' + esc(r.zone.name) + '" data-zone="' + esc(r.zone.id) + '"><span>' + esc(r.zone.name)
                    + '<small>' + (r.inside ? 'Estás dentro de la geocerca' : 'a ' + Math.round(r.dist) + ' m') + '</small></span></button></li>';
            }).join('') + '</ul>';
        }
        html += '<input id="whd-search" class="whd-input" type="search" placeholder="Buscar o escribir el cliente" value="' + esc(q) + '" autocomplete="off">';
        if (q) {
            var list = clientCatalog().filter(function (x) { return norm(x.name).indexOf(nq) >= 0; }).slice(0, 40);
            var exact = list.some(function (x) { return norm(x.name) === nq; });
            html += '<ul class="whd-list whd-pick">' + list.map(function (x) {
                return '<li><button class="whd-user" data-act="checkinSave" data-name="' + esc(x.name) + '"' + (x.zoneId ? ' data-zone="' + esc(x.zoneId) + '"' : '') + '><span>' + esc(x.name)
                    + (x.zoneId ? '<small>con geocerca</small>' : '') + '</span></button></li>';
            }).join('')
                + (exact || q.length < 3 ? '' : '<li><button class="whd-user" data-act="checkinSave" data-name="' + esc(q) + '" data-new="1"><span>+ Cliente nuevo: «' + esc(q) + '»'
                    + '<small>Queda marcado como nuevo para la oficina</small></span></button></li>')
                + '</ul>';
        } else {
            var rec = lsGet('recentClients', []).slice(0, 6);
            if (rec.length) {
                html += '<h3>Recientes</h3><ul class="whd-list whd-pick">' + rec.map(function (n) {
                    return '<li><button class="whd-user" data-act="checkinSave" data-name="' + esc(n) + '"><span>' + esc(n) + '</span></button></li>';
                }).join('') + '</ul>';
            }
        }
        return html;
    }

    function saveCheckin(name, zoneId, isNew) {
        if (!me || !name) { return; }
        var pos = checkin && checkin.pos;
        var veh = myVehicle();
        var point = pos ? { x: pos.lon, y: pos.lat } : null;
        if (!zoneId && point) {
            // si eligió por nombre una geocerca que está cerca, se usa esa
            var n = name.trim().toLowerCase();
            var hit = S.nearbyZones(point, zones, settings).filter(function (r) { return r.zone.name.trim().toLowerCase() === n; })[0];
            if (hit) { zoneId = hit.zone.id; }
        }
        var visit = S.newVisit(me, { client: name, clientNew: !!isNew, zoneId: zoneId || null, deviceId: veh.deviceId, jornadaKey: veh.jornadaKey,
            lat: pos ? pos.lat : null, lon: pos ? pos.lon : null, acc: pos ? pos.acc : null, posSource: pos ? pos.src : '', by: by() });
        var recent = lsGet('recentClients', []).filter(function (c) { return c !== name; });
        recent.unshift(name);
        lsSet('recentClients', recent.slice(0, 30));
        var req = !zoneId && point && S.needsZone(name, point, zones, settings) ? S.newZoneRequest(visit, by()) : null;
        if (req) { req._dirty = true; records[req.key] = req; }
        checkin = null;
        saveLocal(visit, 'checkin', name).then(function () {
            showMsg('Llegada a ' + name + ' registrada a las ' + S.hhmm(visit.at) + '.' + (req ? ' Se pidió la geocerca: la aprueba la oficina.' : ''), 'ok');
            render();
        });
        go('clients');
    }

    function renderClientsHome() {
        var all = allRecords();
        var html = (window.CESETTI_SHELL ? '' : '<button class="whd-back" data-act="sec" data-key="crew">‹ Tripulación</button>')
            + '<button class="whd-btn whd-btn-big" data-act="checkin">📍 Llegué a un cliente</button>';
        var day = today();
        var mineToday = all.filter(function (r) { return r.type === S.VISIT && r.date === day && me && r.userId === me.id; })
            .sort(function (a, b) { return S.toMs(b.at) - S.toMs(a.at); });
        var reqByVisit = {};
        all.forEach(function (r) { if (r.type === S.ZONEREQ) { reqByVisit[r.visitKey] = r; } });
        var matched = {};
        var list = todayJornadas();
        list.forEach(function (x) {
            var tl = timelines[x.j.key] || lsGet('tl.' + x.j.key, null);
            var title = (x.role === 'driver' ? '' : 'Con ' + esc(records[x.j.key] && records[x.j.key].driverName || 'otro chofer') + ' · ') + esc(vehiclesOf(x.j));
            html += '<article class="whd-card"><h2>' + title + '</h2>';
            if (!tl || !tl.groups) {
                html += '<p class="whd-sub">' + (isOnline() ? 'Cargando viajes…' : 'Sin conexión: las visitas se arman cuando haya señal.') + '</p></article>';
                return;
            }
            var rec = S.withVisits(records[x.j.key] || null, tl, all);
            var visits = S.clientVisits(tl, rec);
            if (x.role === 'companion') {
                var mf = S.toMs(x.member.from), mt = x.member.to ? S.toMs(x.member.to) : Infinity;
                visits = visits.filter(function (v) { return v.to > mf && v.from < mt; });
            }
            visits.forEach(function (v) { if (v.checkin) { matched[v.checkin] = true; } });
            var legs = S.clientLegs(tl, rec);
            if (!visits.length) { html += '<p class="whd-sub">Todavía sin visitas a clientes hoy.</p>'; }
            else {
                html += '<ol class="whd-visits">' + visits.map(function (v, i) {
                    var leg = i > 0 ? legs[i - 1] : null;
                    var now = v.final && !v.to ? true : (v.final && Date.now() - v.to < 2 * S.MIN);
                    return (leg ? '<li class="whd-leg">↓ ' + S.fmtDuration(leg.ms) + ' · ' + S.fmtKm(leg.km) + ' km' + (leg.viaBase ? ' · pasó por la oficina' : '') + '</li>' : '')
                        + '<li class="whd-visit"><b>' + esc(v.clients.join(', ')) + '</b><span>' + S.hhmm(v.from) + ' – ' + (now ? 'ahora' : S.hhmm(v.to))
                        + ' · ' + S.fmtDuration(v.to - v.from) + (v.checkin ? ' · llegada registrada' : v.confirmed ? '' : ' · por geocerca') + '</span></li>';
                }).join('') + '</ol>';
                var tot = legs.filter(function (l) { return !l.viaBase; });
                if (tot.length) {
                    html += '<p class="whd-sub">Entre clientes: ' + S.fmtDuration(tot.reduce(function (s, l) { return s + l.ms; }, 0))
                        + ' · ' + S.fmtKm(tot.reduce(function (s, l) { return s + l.km; }, 0)) + ' km</p>';
                }
            }
            if (x.role === 'driver') {
                var miss = S.stopsToAsk(tl).filter(function (s) { var e = S.stopEntry(rec, s.tripId); return !e && !s.zone; }).length;
                html += '<div class="whd-actions"><button class="whd-btn whd-btn-ghost" data-act="stops" data-key="' + esc(x.j.key) + '">'
                    + (miss ? 'Completar ' + miss + (miss === 1 ? ' parada sin cliente' : ' paradas sin cliente') : 'Paradas y clientes') + '</button></div>';
            }
            html += '</article>';
        });
        // llegadas mías que todavía no tienen parada del vehículo (recién llegó o el viaje no subió)
        var pend = mineToday.filter(function (v) { return !matched[v.key]; });
        if (pend.length) {
            html += '<article class="whd-card"><h2>Llegadas registradas</h2><ul class="whd-list">' + pend.slice(0, 5).map(function (v) {
                var rq = reqByVisit[v.key];
                return '<li><span>' + esc(v.client) + '<small>' + S.hhmm(v.at) + ' · esperando la parada del vehículo'
                    + (rq ? ' · geocerca ' + ({ pending: 'pedida', created: 'creada', merged: 'asignada', rejected: 'rechazada' }[rq.status] || '') : '') + '</small></span></li>';
            }).join('') + '</ul></article>';
        }
        if (!list.length && !pend.length) {
            html += '<div class="whd-empty"><p>Cuando llegues a un cliente, tocá <b>Llegué a un cliente</b>. El tiempo en el cliente termina solo cuando el vehículo se va.</p></div>';
        }
        return html;
    }

    // ------------------------------------------------------------------
    // Vista: paradas
    // ------------------------------------------------------------------
    /**
     * Viajes de todos los vehículos de la jornada + odómetro ajustado (el de ODOMETER_REPORT).
     * Se guarda una versión reducida en el teléfono para verla sin señal.
     */
    function loadTimeline(j) {
        if (!isOnline()) { return Promise.resolve(timelines[j.key] || lsGet('tl.' + j.key, null)); }
        var from = S.dayStart(j.date), to = Math.min(S.dayEnd(j.date), Date.now());
        var devs = S.deviceIdsOf(j);
        var calls = [];
        devs.forEach(function (d) {
            // DriverChange de todo el vehículo para cortar la jornada si otra persona lo usó
            calls.push(['Get', { typeName: 'DriverChange', search: { deviceSearch: { id: d }, fromDate: S.iso(from), toDate: S.iso(to) } }]);
            // desde el día anterior: el último viaje previo indica si salió de su casa o de la oficina
            calls.push(['Get', { typeName: 'Trip', search: { deviceSearch: { id: d }, fromDate: S.iso(S.dayStart(S.addDays(j.date, -1))), toDate: S.iso(to) } }]);
        });
        var tl;
        return Promise.all([loadZones(), multiCall(calls)]).then(function (r) {
            var changes = [], trips = [];
            r[1].forEach(function (list, i) { (i % 2 ? trips : changes).push.apply(i % 2 ? trips : changes, list || []); });
            // cualquier otra persona (o llave de mantenimiento) que se identificó corta mi tramo
            var full = S.buildJornadas(changes, { now: Date.now() })
                .filter(function (x) { return x.key === j.key; })[0] || j;
            tl = S.buildTimeline(full, trips, { zones: zones, settings: settings });
            var reqs = S.odometerRequests(tl);
            return multiCall(reqs.map(S.odometerCall)).then(function (res) { return S.odometerMap(reqs, res); })
                .catch(function () { return null; });   // sin permiso a StatusData: se usa el odómetro de los viajes
        }).then(function (odo) {
            var slim = { stops: tl.stops, groups: tl.groups, legs: tl.legs, sheet: tl.sheet, firstStart: tl.firstStart, lastStop: tl.lastStop, odo: odo, at: Date.now() };
            timelines[j.key] = slim;
            lsSet('tl.' + j.key, slim);
            return slim;
        });
    }

    // ------------------------------------------------------------------
    // Vista: planilla del día
    // ------------------------------------------------------------------
    function renderSheet() {
        var j = findJornada(view.key);
        if (!j) { return '<p class="whd-empty">Jornada no encontrada.</p>'; }
        var tl = timelines[j.key] || lsGet('tl.' + j.key, null);
        var html = '<button class="whd-back" data-act="home">‹ Volver</button>'
            + '<h2 class="whd-title">Planilla · ' + (j.date === today() ? 'hoy' : j.date.split('-').reverse().join('/')) + '</h2>';
        if (!tl || !tl.sheet) {
            return html + '<p class="whd-empty">' + (!tl && isOnline() ? 'Cargando viajes y odómetro…'
                : (tl ? 'Sin viajes registrados en la jornada.' : 'Sin conexión: la planilla se arma cuando haya señal.')) + '</p>';
        }
        var rec = recordFor(j);
        var p = S.buildPlanilla(j, tl, rec, tl.odo);
        var row = function (label, value) { return '<div class="whd-row"><span>' + esc(label) + '</span><b>' + value + '</b></div>'; };
        html += '<div class="whd-sheet">';
        html += row('Salida', S.hhmm(p.depart.at) + (p.depart.kind === 'unknown' ? '' : ' <small>desde ' + esc(p.depart.place) + '</small>'));
        p.vehicles.forEach(function (v) {
            var name = p.vehicles.length > 1 ? ' · ' + esc(devices[v.deviceId] || v.deviceId) : '';
            html += row('Odómetro inicial' + name, S.fmtKm(v.odoStart) + ' km');
            html += row('Odómetro final' + name, S.fmtKm(v.odoEnd) + ' km');
        });
        html += row('Km recorridos', S.fmtKm(p.kmTotal) + ' km');
        html += row('Km entre clientes', S.fmtKm(p.kmBetweenClients) + ' km');
        html += row('Llegada', S.hhmm(p.arrive.at) + ' <small>a ' + esc(p.arrive.place) + '</small>');
        html += row('Acompañantes', p.companions.length
            ? p.companions.map(function (c) { return esc(c.name) + ' <small>' + S.hhmm(c.from) + '–' + (c.to ? S.hhmm(c.to) : 'fin') + '</small>'; }).join('<br>')
            : (p.solo ? 'Viajó solo' : '<span class="whd-warn-txt">Sin cargar</span>'));
        html += '</div>';

        html += '<h3>Visitas a clientes</h3>';
        if (p.visits.length) {
            html += '<ul class="whd-list">' + p.visits.map(function (v) {
                return '<li><span>' + esc(v.client) + (v.confirmed ? '' : '<small>por geocerca, sin confirmar</small>') + '</span><b>'
                    + S.hhmm(v.from) + ' – ' + S.hhmm(v.to) + '</b></li>';
            }).join('') + '</ul>';
        } else {
            html += '<p class="whd-hint">Sin visitas. Si estuviste en clientes, cargalos en "Paradas y clientes".</p>';
        }
        var pending = S.stopsToAsk(tl).filter(function (s) { return !S.stopEntry(rec, s.tripId) && !s.zone; }).length;
        if (pending) {
            html += '<p class="whd-msg whd-msg-error">' + pending + (pending === 1 ? ' parada sin cliente.' : ' paradas sin cliente.')
                + ' <button class="whd-btn whd-btn-sm whd-btn-ghost" data-act="stops" data-key="' + esc(j.key) + '">Completar</button></p>';
        }
        if (p.vehicles.some(function (v) { return v.source !== 'ajustado'; })) {
            html += '<p class="whd-hint">Odómetro tomado de los viajes (no se pudo leer el odómetro ajustado).</p>';
        }

        var c = p.confirmation;
        if (c && !p.changed) {
            html += '<p class="whd-msg whd-msg-ok">Confirmada el ' + new Date(c.confirmedAt).toLocaleString('es-AR') + '.</p>';
        } else if (c && p.changed) {
            html += '<p class="whd-msg whd-msg-error">La planilla cambió desde que la confirmaste. Revisala y volvé a confirmar.</p>';
        }
        html += '<h3>Observaciones</h3><textarea id="whd-notes" class="whd-input" rows="3" maxlength="500" placeholder="Opcional">'
            + esc(c ? c.notes : '') + '</textarea>'
            + '<div class="whd-bar whd-bar-static"><button class="whd-btn" data-act="confirmSheet"' + (c && !p.changed ? ' disabled' : '') + '>'
            + (c && !p.changed ? 'Planilla confirmada' : 'Confirmar planilla') + '</button></div>';
        return html;
    }

    function confirmSheet() {
        var j = findJornada(view.key);
        var tl = j && (timelines[j.key] || lsGet('tl.' + j.key, null));
        if (!tl || !tl.sheet) { return; }
        var rec = S.clone(recordFor(j));
        var p = S.buildPlanilla(j, tl, rec, tl.odo);
        rec.planilla = S.planillaConfirmation(p, by(), ($('#whd-notes') || {}).value || '', devices);
        saveLocal(rec, 'planilla', S.fmtKm(p.kmTotal) + ' km').then(render);
        render();
    }

    function clientOptions(stop, entry) {
        var opts = [];
        var seen = {};
        function add(v, label) { if (v && !seen[v]) { seen[v] = true; opts.push({ v: v, l: label || v }); } }
        if (stop.zone) { add(stop.zone.name, stop.zone.name + ' (geocerca)'); }
        ((settings.clients || []).slice().sort(function (a, b) { return a.localeCompare(b, 'es'); })).forEach(function (c) { add(c); });
        (lsGet('recentClients', [])).forEach(function (c) { add(c); });
        var cur = entry && entry.clients && entry.clients[0];
        if (cur) { add(cur); }
        return opts;
    }

    function renderStops() {
        var j = findJornada(view.key);
        if (!j) { return '<p class="whd-empty">Jornada no encontrada.</p>'; }
        var tl = timelines[j.key] || lsGet('tl.' + j.key, null);
        var html = '<button class="whd-back" data-act="home">‹ Volver</button>'
            + '<h2 class="whd-title">Paradas · ' + esc(vehiclesOf(j)) + '</h2>';
        if (!tl) {
            return html + '<p class="whd-empty">' + (isOnline() ? 'Cargando viajes…' : 'Sin conexión: las paradas se cargan cuando haya señal.') + '</p>';
        }
        var rec = S.withVisits(recordFor(j), tl, allRecords());
        var ask = S.stopsToAsk(tl);
        if (!ask.length) {
            return html + '<p class="whd-empty">No hay paradas de más de ' + settings.minStopMinutes + ' minutos fuera de la base.</p>';
        }
        html += '<p class="whd-hint">Indicá el cliente de cada parada de más de ' + settings.minStopMinutes + ' minutos. Las que caen en una geocerca ya vienen sugeridas.</p>';
        html += ask.map(function (s, i) {
            var e = S.stopEntry(rec, s.tripId);
            var cur = e ? (e.noClient ? '__none' : (e.clients && e.clients[0]) || '') : (s.zone ? s.zone.name : '');
            var opts = clientOptions(s, e);
            var isOther = cur && cur !== '__none' && !opts.some(function (o) { return o.v === cur; });
            return '<div class="whd-stop' + (e ? ' is-done' : '') + '" data-trip="' + esc(s.tripId) + '">'
                + '<div class="whd-stop-time"><b>' + S.hhmm(s.from) + ' – ' + S.hhmm(s.to) + '</b><span>' + S.fmtDuration(s.duration) + (e ? ' · confirmada' : '') + '</span></div>'
                + (s.moves ? '<p class="whd-hint">Incluye ' + s.moves + (s.moves === 1 ? ' movimiento' : ' movimientos') + ' dentro del mismo predio.</p>' : '')
                + '<select class="whd-input" data-stop-sel="' + i + '">'
                + '<option value="">Elegí el cliente…</option>'
                + opts.map(function (o) { return '<option value="' + esc(o.v) + '"' + (o.v === cur ? ' selected' : '') + '>' + esc(o.l) + '</option>'; }).join('')
                + '<option value="__other"' + (isOther ? ' selected' : '') + '>Otro (escribir)…</option>'
                + '<option value="__none"' + (cur === '__none' ? ' selected' : '') + '>Sin cliente (comida, combustible, etc.)</option>'
                + '</select>'
                + '<input class="whd-input" data-stop-other="' + i + '" type="text" placeholder="Nombre del cliente" value="' + esc(isOther ? cur : '') + '"' + (isOther ? '' : ' hidden') + '>'
                + '</div>';
        }).join('');
        html += '<div class="whd-bar"><button class="whd-btn" data-act="saveStops">Guardar paradas</button></div>';
        return html;
    }

    function saveStops() {
        var j = findJornada(view.key);
        var tl = j && (timelines[j.key] || lsGet('tl.' + j.key, null));
        if (!tl) { return; }
        var ask = S.stopsToAsk(tl);
        var rec = S.clone(recordFor(j));
        var recent = lsGet('recentClients', []);
        var n = 0, missing = 0;
        ask.forEach(function (s, i) {
            var sel = $('[data-stop-sel="' + i + '"]');
            var val = sel ? sel.value : '';
            if (val === '__other') { val = (($('[data-stop-other="' + i + '"]') || {}).value || '').trim(); }
            if (!val) { missing++; return; }
            var entry = S.stopEntry(rec, s.tripId);
            if (!entry) { entry = { tripId: s.tripId }; rec.stops.push(entry); }
            entry.from = S.iso(s.from); entry.to = S.iso(s.to);
            entry.zoneId = s.zone ? s.zone.id : null;
            entry.zoneName = s.zone ? s.zone.name : null;
            entry.noClient = val === '__none';
            entry.clients = entry.noClient ? [] : [val];
            entry.by = by(); entry.at = S.iso(Date.now());
            if (!entry.noClient && (!s.zone || s.zone.name !== val) && recent.indexOf(val) < 0) { recent.unshift(val); }
            n++;
        });
        if (!n) { showMsg('Elegí el cliente de al menos una parada.', 'error'); return; }
        lsSet('recentClients', recent.slice(0, 30));
        saveLocal(rec, 'stops', n + ' parada(s)').then(function () {
            if (missing) { showMsg('Guardado. Quedan ' + missing + ' parada(s) sin cliente.', 'info'); }
            render();
        });
        render();
    }

    // ------------------------------------------------------------------
    // Render y eventos
    // ------------------------------------------------------------------
    function vehiclesOf(j) {
        return S.deviceIdsOf(j).map(function (d) { return devices[d] || d; }).join(' + ');
    }

    function findJornada(key) { return jornadas.filter(function (j) { return j.key === key; })[0] || null; }

    function render() {
        root = document.getElementById('whDrive') || root;
        if (!root) { return; }
        var who = $('#whd-who');
        if (who) { who.textContent = me ? me.name : ''; }
        renderSync();
        var html;
        if (view.name === 'crew') { html = renderCrew(); }
        else if (view.name === 'stops') { html = renderStops(); }
        else if (view.name === 'sheet') { html = renderSheet(); }
        else if (view.name === 'claim') { html = renderClaim(); }
        else if (view.name === 'clients') { html = renderClientsHome(); }
        else if (view.name === 'checkin') { html = renderCheckin(); }
        else { html = renderHome(); }
        var el = $('#whd-view');
        var search = $('#whd-search');
        var hadFocus = search && document.activeElement === search;
        el.innerHTML = html;
        if (hadFocus && $('#whd-search')) {
            var s = $('#whd-search');
            s.focus();
            s.setSelectionRange(s.value.length, s.value.length);
        }
    }

    function go(name, key) {
        if (name === 'home' && section === 'clients') { name = 'clients'; }
        view = { name: name, key: key || null };
        picked = {};
        render();
        if (name === 'clients') { loadClientTimelines().then(function () { if (view.name === 'clients') { render(); } }); }
        if (name === 'stops' || name === 'sheet') {
            var j = findJornada(key);
            if (j) {
                // Primero se muestra lo guardado en el teléfono. Al llegar los datos del servidor se
                // redibuja solo si cambiaron y si sigue en la misma vista: así no se pierde lo que el
                // chofer está eligiendo en ese momento.
                var fingerprint = function (tl) { return tl ? JSON.stringify([tl.stops, tl.legs, tl.sheet, tl.odo]) : ''; };
                var shown = fingerprint(timelines[j.key] || lsGet('tl.' + j.key, null));
                var same = function () { return view.name === name && view.key === key; };
                loadTimeline(j).then(function (tl) {
                    if (same() && fingerprint(tl) !== shown) { render(); }
                }).catch(function (e) {
                    showMsg('No se pudieron leer los viajes: ' + errText(e), 'error');
                    if (same() && !shown) { render(); }
                });
            }
        }
        if (root && root.scrollIntoView) { root.scrollIntoView(); }
    }

    function refresh(full) {
        root && root.classList.add('is-busy');
        return check({ full: full }).then(function () {
            return view.name === 'clients' ? loadClientTimelines() : null;
        }).then(function () { render(); }).catch(function (e) {
            showMsg(errText(e), 'error');
            render();
        }).finally(function () { root && root.classList.remove('is-busy'); });
    }

    // Drive puede volver a insertar el HTML del add-in cada vez que se abre la página (initialize
    // corre una vez, focus cada vez): los eventos se escuchan en el documento, no en el elemento.
    function inRoot(el) {
        var r = document.getElementById('whDrive');
        if (!r || !el || !r.contains(el)) { return false; }
        root = r;
        return true;
    }
    // Los escuchadores se instalan una sola vez por documento y llaman a la instancia activa
    // (la última que pasó por initialize/focus): Drive puede crear una instancia para startup y
    // otra para la página.
    function bindEvents() {
        window.__whdHandlers = { click: onClick, change: onChange, input: onInput };
        if (window.__whdBound) { return; }
        window.__whdBound = true;
        ['click', 'change', 'input'].forEach(function (type) {
            document.addEventListener(type, function (e) {
                var h = window.__whdHandlers && window.__whdHandlers[type];
                if (h) { h(e); }
            });
        });
    }
    function onClick(e) {
        (function () {
            var t = e.target && e.target.nodeType === 1 ? e.target : e.target && e.target.parentElement;
            if (t && t.closest && t.closest('#whd-refresh') && inRoot(t)) { refresh(true); return; }
            var b = t && t.closest ? t.closest('[data-act]') : null;
            if (!b || b.disabled || !inRoot(b)) { return; }
            var act = b.getAttribute('data-act'), key = b.getAttribute('data-key');
            if (act === 'home') { go('home'); }
            else if (act === 'crew') { go('crew', key); }
            else if (act === 'stops') { go('stops', key); }
            else if (act === 'saveCrew') { saveCrew(); }
            else if (act === 'solo') { saveSolo(); }
            else if (act === 'drop') { dropMember(b.getAttribute('data-user')); }
            else if (act === 'saveStops') { saveStops(); }
            else if (act === 'sheet') { go('sheet', key); }
            else if (act === 'confirmSheet') { confirmSheet(); }
            else if (act === 'ack') { saveAck(key, b.getAttribute('data-status')); }
            else if (act === 'checkin') { startCheckin(); }
            else if (act === 'sec') { section = key === 'clients' ? 'clients' : 'crew'; go('home'); }
            else if (act === 'checkinSave') { saveCheckin(b.getAttribute('data-name'), b.getAttribute('data-zone'), b.getAttribute('data-new') === '1'); }
            else if (act === 'claimStart') { go('claim'); }
            else if (act === 'claimSave') { saveClaim(b.getAttribute('data-user')); }
            else if (act === 'claimOk') { resolveClaim(key, true); }
            else if (act === 'claimNo') { resolveClaim(key, false); }
            else if (act === 'retry') {
                b.disabled = true;
                flush().then(function () {
                    showMsg(pendingSync() ? 'Sigue sin sincronizar: ' + ((lsGet('syncError', null) || {}).text || '') : 'Sincronizado.',
                        pendingSync() ? 'error' : 'ok');
                    render();
                });
            }
        }());
    }
    function onChange(e) {
        (function () {
            if (!inRoot(e.target)) { return; }
            var pick = e.target.getAttribute('data-pick');
            if (pick) {
                if (e.target.checked) { picked[pick] = true; } else { delete picked[pick]; }
                render();
                return;
            }
            var sel = e.target.getAttribute('data-stop-sel');
            if (sel != null) {
                var other = $('[data-stop-other="' + sel + '"]');
                if (other) { other.hidden = e.target.value !== '__other'; if (!other.hidden) { other.focus(); } }
            }
        }());
    }
    function onInput(e) {
        if (e.target.id === 'whd-search' && inRoot(e.target)) { render(); }
    }

    function setup(freshApi, freshState) {
        api = freshApi;
        state = freshState || state;
        if (!store) { store = new S.Store(call, multiCall); }
        loadCache();
    }

    // ------------------------------------------------------------------
    // Ciclo de vida
    // ------------------------------------------------------------------
    return {
        /** onStartup: corre al iniciar sesión en Drive, sin interfaz. */
        startup: function (freshApi, freshState, initializeCallback) {
            setup(freshApi, freshState);
            var done = false;
            function finish() { if (!done) { done = true; initializeCallback(); } }
            check({ full: true }).catch(function () { /* sin red: se reintenta en el ciclo */ })
                .then(function () { startLoop(); finish(); });
            setTimeout(finish, 8000);   // nunca bloquear el inicio de Drive
        },
        initialize: function (freshApi, freshState, callback) {
            setup(freshApi, freshState);
            root = document.getElementById('whDrive');
            bindEvents();
            render();
            callback();
        },
        focus: function (freshApi, freshState) {
            setup(freshApi, freshState);
            root = document.getElementById('whDrive') || root;
            bindEvents();
            view = { name: section === 'clients' ? 'clients' : 'home', key: null };
            render();
            startLoop();
            refresh(true);
        },
        blur: function () { /* el ciclo de revisión sigue corriendo */ },
        /** onShutdown: último intento de sincronizar (Drive da 15 s). */
        shutdown: function (freshApi, freshState, callback) {
            setup(freshApi, freshState);
            var p = Promise.race([flush(), new Promise(function (r) { setTimeout(r, 12000); })]);
            return p.then(function () { if (typeof callback === 'function') { callback(); } });
        },
        /** Para el contenedor: cosas que esperan una respuesta de esta persona. */
        pendingCount: function () { return pendingActions(); },
        /** Pestaña del contenedor: 'crew' (Tripulación) o 'clients' (Clientes). */
        section: function (name) {
            section = name === 'clients' ? 'clients' : 'crew';
            go('home');
        },
        refresh: function () { return refresh(true); }
    };
};
// Dentro del add-in unificado "Mi jornada" (window.CESETTI_SHELL) lo registra el contenedor;
// suelto, se registra como siempre.
window.CesettiModules = window.CesettiModules || {};
window.CesettiModules.workingHours = factory;
if (!window.CESETTI_SHELL) { window.geotab = window.geotab || { addin: {} }; geotab.addin.workingHoursDrive = factory; }
}());
