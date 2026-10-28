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
geotab.addin.workingHoursDrive = function () {
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
    var timer = null, checking = null, listening = false, bound = false;

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

    function errText(e) {
        if (!e) { return 'Error desconocido'; }
        if (typeof e === 'string') { return e; }
        return e.message || (e.errors && e.errors[0] && e.errors[0].message) || e.name || 'Error';
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
            return store.crewByDates([S.addDays(today(), -1), today()]);
        }).then(function (recs) {
            recs.forEach(function (r) {
                var local = records[r.key];
                if (local && local._dirty) { local._id = local._id || r._id; return; }   // gana lo local sin sincronizar
                records[r.key] = r;
            });
            saveRecordsLocal();
            lsSet('checkedAt', Date.now());
            return loadDeviceNames(jornadas.map(function (j) { return j.deviceId; }));
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
        return keys.reduce(function (p, k) {
            return p.then(function () {
                return store.save(records[k]).then(function (saved) {
                    // si hubo otra edición local mientras se guardaba, se vuelve a marcar
                    if (records[k] && records[k].updatedAt !== saved.updatedAt) { records[k]._id = saved._id; return; }
                    records[k] = saved;
                }).catch(function () { /* queda pendiente */ });
            });
        }, Promise.resolve()).then(function () { saveRecordsLocal(); renderSync(); });
    }

    function saveLocal(rec, action, detail) {
        S.addHistory(rec, by(), action, detail);
        rec._dirty = true;
        records[rec.key] = rec;
        saveRecordsLocal();
        renderSync();
        return flush().then(function () {
            showMsg(records[rec.key] && records[rec.key]._dirty
                ? 'Guardado en el teléfono. Se sincroniza cuando haya señal.' : 'Guardado.', 'ok');
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

    function notifyPending() {
        var notified = lsGet('notified', {});
        var day = today();
        jornadas.forEach(function (j) {
            if (j.date !== day || notified[j.key] || S.hasCrew(records[j.key])) { return; }
            notified[j.key] = Date.now();
            var veh = devices[j.deviceId] || 'un vehículo';
            notify('¿Quién viaja con vos?',
                'Te identificaste en ' + veh + ' a las ' + S.hhmm(j.firstAt) + '. Abrí Horas de trabajo y cargá tus acompañantes.');
        });
        // limpieza: solo se recuerdan las de los últimos 3 días
        var min = S.addDays(day, -3);
        Object.keys(notified).forEach(function (k) { if (k.slice(0, 10) < min) { delete notified[k]; } });
        lsSet('notified', notified);
    }

    function startLoop() {
        if (timer) { return; }
        var every = Math.max(1, settings.pollMinutes || 2) * 60000;
        timer = setInterval(function () {
            check().then(function () { if (root && view.name === 'home') { render(); } }).catch(function () { /* reintenta */ });
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
            r = S.newCrewRecord(j, { deviceName: devices[j.deviceId] || '', driverName: me ? me.name : '', by: by(), source: 'drive' });
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
        el.textContent = parts.join(' · ');
        el.hidden = !parts.length;
    }

    function renderHome() {
        var day = today();
        var list = jornadas.slice().sort(function (a, b) { return b.firstAt - a.firstAt; });
        if (!list.length) {
            return '<div class="whd-empty"><p><b>Sin identificaciones hoy.</b></p>'
                + '<p>Cuando pases el llavero o la cámara te identifique en un vehículo, te vamos a avisar para que cargues quién viaja con vos.</p></div>';
        }
        return list.map(function (j) {
            var rec = records[j.key];
            var names = memberNames(rec);
            var crew;
            if (!S.hasCrew(rec)) { crew = '<span class="whd-pill whd-pill-warn">Falta cargar acompañantes</span>'; }
            else if (rec.solo && !names.length) { crew = '<span class="whd-pill">Viajó solo</span>'; }
            else { crew = '<span class="whd-pill whd-pill-ok">' + esc(names.join(', ') || 'Sin acompañantes ahora') + '</span>'; }
            var closed = rec && rec.status === 'closed';
            var dayLbl = j.date === day ? 'Hoy' : 'Ayer';
            return '<article class="whd-card' + (closed ? ' is-closed' : '') + '">'
                + '<div class="whd-card-head"><div><h2>' + esc(devices[j.deviceId] || j.deviceId) + '</h2>'
                + '<p class="whd-sub">' + dayLbl + ' · identificado a las ' + S.hhmm(j.firstAt) + (closed ? ' · jornada cerrada' : '') + '</p></div></div>'
                + '<div class="whd-crew">' + crew + '</div>'
                + '<div class="whd-actions">'
                + '<button class="whd-btn" data-act="crew" data-key="' + esc(j.key) + '">' + (S.hasCrew(rec) ? 'Tripulación' : 'Cargar acompañantes') + '</button>'
                + '<button class="whd-btn whd-btn-ghost" data-act="stops" data-key="' + esc(j.key) + '">Paradas y clientes</button>'
                + (closed ? '' : '<button class="whd-btn whd-btn-ghost" data-act="close" data-key="' + esc(j.key) + '">Cerrar jornada</button>')
                + '</div></article>';
        }).join('');
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
            + '<h2 class="whd-title">' + esc(devices[j.deviceId] || j.deviceId) + '</h2>'
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
    // Vista: paradas
    // ------------------------------------------------------------------
    function loadTimeline(j) {
        if (!isOnline()) { return Promise.resolve(timelines[j.key] || lsGet('tl.' + j.key, null)); }
        var from = S.dayStart(j.date), to = Math.min(S.dayEnd(j.date), Date.now());
        // DriverChange de todo el vehículo para cortar la jornada si otra persona lo usó
        return Promise.all([loadZones(), multiCall([
            ['Get', { typeName: 'DriverChange', search: { deviceSearch: { id: j.deviceId }, fromDate: S.iso(from), toDate: S.iso(to) } }],
            ['Get', { typeName: 'Trip', search: { deviceSearch: { id: j.deviceId }, fromDate: S.iso(from), toDate: S.iso(to) } }]
        ])]).then(function (r) {
            var res = r[1];
            // cualquier otra persona (o llave de mantenimiento) que se identificó corta mi tramo
            var full = S.buildJornadas(res[0], { now: Date.now() })
                .filter(function (x) { return x.key === j.key; })[0] || j;
            var tl = S.buildTimeline(full, res[1], { zones: zones, settings: settings });
            var slim = { stops: tl.stops, firstStart: tl.firstStart, lastStop: tl.lastStop, at: Date.now() };
            timelines[j.key] = slim;
            lsSet('tl.' + j.key, slim);
            return slim;
        });
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
            + '<h2 class="whd-title">Paradas · ' + esc(devices[j.deviceId] || j.deviceId) + '</h2>';
        if (!tl) {
            return html + '<p class="whd-empty">' + (isOnline() ? 'Cargando viajes…' : 'Sin conexión: las paradas se cargan cuando haya señal.') + '</p>';
        }
        var rec = recordFor(j);
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
    // Cierre
    // ------------------------------------------------------------------
    function closeJornada(key) {
        var j = findJornada(key);
        if (!j) { return; }
        var rec = recordFor(j);
        var msg = '¿Cerrar la jornada en ' + (devices[j.deviceId] || j.deviceId) + '?';
        if (!S.hasCrew(rec)) { msg += '\n\nTodavía no cargaste acompañantes: se registra que viajaste solo.'; }
        var active = S.activeMembers(rec);
        if (active.length) { msg += '\n\nSe marca que bajaron ahora: ' + active.map(function (m) { return m.name; }).join(', ') + '.'; }
        if (!window.confirm(msg)) { return; }
        rec = S.clone(rec);
        if (!S.hasCrew(rec)) { rec.solo = true; }
        rec.members.forEach(function (m) { if (!m.to) { m.to = S.iso(Date.now()); } });
        rec.status = 'closed';
        rec.closedAt = S.iso(Date.now());
        rec.closedBy = by();
        saveLocal(rec, 'close', '').then(render);
        render();
    }

    // ------------------------------------------------------------------
    // Render y eventos
    // ------------------------------------------------------------------
    function findJornada(key) { return jornadas.filter(function (j) { return j.key === key; })[0] || null; }

    function render() {
        if (!root) { return; }
        var who = $('#whd-who');
        if (who) { who.textContent = me ? me.name : ''; }
        renderSync();
        var html;
        if (view.name === 'crew') { html = renderCrew(); }
        else if (view.name === 'stops') { html = renderStops(); }
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
        view = { name: name, key: key || null };
        picked = {};
        render();
        if (name === 'stops') {
            var j = findJornada(key);
            if (j) {
                loadTimeline(j).then(render).catch(function (e) { showMsg('No se pudieron leer los viajes: ' + errText(e), 'error'); render(); });
            }
        }
        if (root && root.scrollIntoView) { root.scrollIntoView(); }
    }

    function refresh(full) {
        root && root.classList.add('is-busy');
        return check({ full: full }).then(function () { render(); }).catch(function (e) {
            showMsg(errText(e), 'error');
            render();
        }).finally(function () { root && root.classList.remove('is-busy'); });
    }

    function bindEvents() {
        root.addEventListener('click', function (e) {
            var b = e.target.closest('[data-act]');
            if (!b || b.disabled) { return; }
            var act = b.getAttribute('data-act'), key = b.getAttribute('data-key');
            if (act === 'home') { go('home'); }
            else if (act === 'crew') { go('crew', key); }
            else if (act === 'stops') { go('stops', key); }
            else if (act === 'close') { closeJornada(key); }
            else if (act === 'saveCrew') { saveCrew(); }
            else if (act === 'solo') { saveSolo(); }
            else if (act === 'drop') { dropMember(b.getAttribute('data-user')); }
            else if (act === 'saveStops') { saveStops(); }
        });
        root.addEventListener('change', function (e) {
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
        });
        root.addEventListener('input', function (e) {
            if (e.target.id === 'whd-search') { render(); }
        });
        $('#whd-refresh').addEventListener('click', function () { refresh(true); });
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
            if (root && !bound) { bindEvents(); bound = true; }
            render();
            callback();
        },
        focus: function (freshApi, freshState) {
            setup(freshApi, freshState);
            root = document.getElementById('whDrive') || root;
            view = { name: 'home', key: null };
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
        }
    };
};
