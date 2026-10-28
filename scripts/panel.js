/**
 * Horas de trabajo — página de MyGeotab (ActivityLink/).
 *
 * Arma las jornadas del período a partir de DriverChange + Trip, las cruza con las
 * tripulaciones cargadas desde Drive (AddInData) y calcula las horas por operario.
 * Desde acá la oficina puede completar o corregir tripulaciones y clientes (queda en el
 * historial del registro) y configurar grupos, zonas base y catálogo de clientes.
 *
 * API de add-ins de página (verificada):
 *   api.call(method, params, success, error) · api.multiCall(calls, success, error)
 *   api.getSession(callback[, newSession:boolean])   ← el 2.º NO es callback de error
 *
 * Ingeniero Jorge Cesetti SRL
 */
/* global geotab, WorkingHoursShared */
geotab.addin.workingHours = function () {
    'use strict';

    var S = WorkingHoursShared;
    var esc = S.esc;
    var MAX_DAYS = 62;
    var ZONE_TYPE_NAMES = {
        ZoneTypeCustomerId: 'Cliente', ZoneTypeOfficeId: 'Oficina', ZoneTypeHomeId: 'Domicilio',
        ZoneTypeAreaId: 'Área', ZoneTypeVendorServiceCenterId: 'Proveedor / centro de servicio'
    };

    var api, root;
    var session = { userName: '' };
    var settings = S.clone(S.DEFAULT_SETTINGS);
    var store = null;
    var users = {}, groups = [], devices = {}, zones = [], zoneTypes = [];
    var refLoaded = false;
    var range = { from: null, to: null };
    var items = [];          // [{ jornada, timeline, rec }]
    var summary = {};        // de S.summarize
    var visits = [];         // visitas a clientes
    var openUser = null;     // operario expandido en Horas
    var tab = 'hours';
    var busy = false;
    var modalKey = null;

    // ------------------------------------------------------------------
    // Utilidades
    // ------------------------------------------------------------------
    function $(sel) { return root.querySelector(sel); }
    function call(method, params) {
        return new Promise(function (resolve, reject) { api.call(method, params, resolve, reject); });
    }
    function multiCall(calls) {
        if (!calls.length) { return Promise.resolve([]); }
        return new Promise(function (resolve, reject) { api.multiCall(calls, resolve, reject); });
    }
    function errText(e) {
        if (!e) { return 'Error desconocido'; }
        if (typeof e === 'string') { return e; }
        return e.message || (e.errors && e.errors[0] && e.errors[0].message) || e.name || 'Error';
    }
    function showMsg(text, kind) {
        var el = $('#wh-msg');
        el.textContent = text;
        el.className = 'wh-msg wh-msg-' + (kind || 'info');
        el.hidden = false;
        clearTimeout(showMsg.t);
        if (kind !== 'error') { showMsg.t = setTimeout(function () { el.hidden = true; }, 6000); }
    }
    function setBusy(b, text) {
        busy = b;
        root.classList.toggle('is-busy', b);
        $('#wh-load').disabled = b;
        $('#wh-status').textContent = b ? (text || 'Cargando…') : '';
    }
    function uName(id) { return users[id] ? S.userName(users[id]) : (id || '—'); }
    function uLegajo(id) { return users[id] && users[id].employeeNo || ''; }
    function dName(id) { return devices[id] ? devices[id].name : (id || '—'); }
    function fmtDate(key) { var p = key.split('-'); return p[2] + '/' + p[1] + '/' + p[0]; }
    function download(name, text) {
        var blob = new Blob([text], { type: 'text/csv;charset=utf-8' });
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = name;
        document.body.appendChild(a);
        a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 500);
    }
    function matches(text, filter) { return !filter || String(text).toLowerCase().indexOf(filter) >= 0; }

    // ------------------------------------------------------------------
    // Carga
    // ------------------------------------------------------------------
    function loadReference() {
        if (refLoaded) { return Promise.resolve(); }
        return multiCall([
            ['Get', { typeName: 'Device', propertySelector: { fields: ['id', 'name', 'licensePlate', 'activeTo'], isIncluded: true } }],
            ['Get', { typeName: 'User', search: { isDriver: true } }],
            ['Get', { typeName: 'Group' }],
            ['Get', { typeName: 'Zone', propertySelector: { fields: ['id', 'name', 'zoneTypes', 'points', 'activeTo'], isIncluded: true } }]
        ]).then(function (r) {
            devices = {};
            (r[0] || []).forEach(function (d) { devices[d.id] = d; });
            users = {};
            (r[1] || []).forEach(function (u) { users[u.id] = u; });
            groups = r[2] || [];
            zones = (r[3] || []).filter(function (z) { return S.isActive(z); }).map(S.compactZone);
            return call('Get', { typeName: 'ZoneType' }).then(function (zt) { zoneTypes = zt || []; })
                .catch(function () { zoneTypes = []; });
        }).then(function () { refLoaded = true; });
    }

    function excludedSet() {
        var ex = S.expandGroups(groups, settings.excludeGroupIds || []);
        var out = {};
        Object.keys(users).forEach(function (id) { if (S.userInGroups(users[id], ex)) { out[id] = true; } });
        return out;
    }

    function load() {
        var from = $('#wh-from').value, to = $('#wh-to').value;
        if (!from || !to) { showMsg('Elegí el período.', 'error'); return; }
        if (from > to) { var t = from; from = to; to = t; }
        var days = S.daysBetween(from, to);
        if (days.length > MAX_DAYS) { showMsg('El período máximo es de ' + MAX_DAYS + ' días.', 'error'); return; }
        range = { from: from, to: to };
        setBusy(true, 'Leyendo configuración…');
        loadReference().then(function () {
            return store.settings().then(function (s) { settings = s; });
        }).then(function () {
            setBusy(true, 'Leyendo identificaciones y viajes…');
            var fromIso = S.iso(S.dayStart(from)), toIso = S.iso(Math.min(S.dayEnd(to), Date.now()));
            return Promise.all([
                multiCall([
                    ['Get', { typeName: 'DriverChange', search: { fromDate: fromIso, toDate: toIso } }],
                    ['Get', {
                        typeName: 'Trip', search: { fromDate: fromIso, toDate: toIso },
                        propertySelector: { fields: ['id', 'device', 'driver', 'start', 'stop', 'stopDuration', 'stopPoint', 'nextTripStart', 'drivingDuration', 'distance'], isIncluded: true }
                    }]
                ]),
                store.crewByDates(days)
            ]);
        }).then(function (r) {
            var changes = r[0][0] || [], trips = r[0][1] || [], recs = r[1] || [];
            var ex = excludedSet();
            var jornadas = S.buildJornadas(changes, { now: Date.now(), isExcluded: function (id) { return !!ex[id]; } })
                .filter(function (j) { return j.date >= from && j.date <= to; });
            var byKey = {};
            recs.forEach(function (rec) { byKey[rec.key] = rec; });
            var tripsByDevice = {};
            trips.forEach(function (t) { var d = S.idOf(t.device); (tripsByDevice[d] = tripsByDevice[d] || []).push(t); });
            items = jornadas.map(function (j) {
                return {
                    jornada: j,
                    timeline: S.buildTimeline(j, tripsByDevice[j.deviceId] || [], { zones: zones, settings: settings }),
                    rec: byKey[j.key] || null
                };
            });
            // registros cargados para jornadas que ya no aparecen (p. ej. borradas) igual se listan
            recompute();
            setBusy(false);
            renderAll();
            var pend = items.filter(function (it) { return !S.hasCrew(it.rec); }).length;
            showMsg(items.length + ' jornadas en el período' + (pend ? ' · ' + pend + ' sin tripulación cargada' : '') + '.', 'ok');
        }).catch(function (e) {
            setBusy(false);
            showMsg('No se pudo cargar: ' + errText(e), 'error');
        });
    }

    function recompute() {
        summary = S.summarize(items);
        visits = [];
        items.forEach(function (it) {
            if (!it.timeline || it.timeline.firstStart == null) { return; }
            var people = S.participants(it.jornada, it.rec);
            S.clientVisits(it.timeline, it.rec).forEach(function (v) {
                var present = people.filter(function (p) {
                    return S.clip([{ from: v.from, to: v.to }], p.from, p.to).length;
                }).map(function (p) { return p.userId; });
                visits.push({
                    date: it.jornada.date, key: it.jornada.key, deviceId: it.jornada.deviceId,
                    client: v.clients.join(', '), from: v.from, to: v.to, duration: v.to - v.from,
                    people: present, confirmed: v.confirmed
                });
            });
        });
        visits.sort(function (a, b) { return b.from - a.from; });
        var dl = $('#wh-client-list');
        var names = {};
        (settings.clients || []).forEach(function (c) { names[c] = true; });
        visits.forEach(function (v) { v.client.split(', ').forEach(function (c) { names[c] = true; }); });
        zones.forEach(function (z) { names[z.name] = true; });
        dl.innerHTML = Object.keys(names).sort().slice(0, 1500).map(function (n) { return '<option value="' + esc(n) + '">'; }).join('');
    }

    // ------------------------------------------------------------------
    // Pestaña Horas
    // ------------------------------------------------------------------
    function hoursByUser() {
        var byUser = {};
        Object.keys(summary).forEach(function (k) {
            var s = summary[k];
            var u = byUser[s.userId] || (byUser[s.userId] = { userId: s.userId, days: [], outside: 0, driving: 0, riding: 0, client: 0, pending: 0 });
            u.days.push(s);
            u.outside += s.outside; u.driving += s.driving; u.riding += s.riding; u.client += s.client;
        });
        items.forEach(function (it) {
            if (S.hasCrew(it.rec)) { return; }
            var u = byUser[it.jornada.driverId];
            if (u) { u.pending++; }
        });
        return Object.keys(byUser).map(function (k) {
            var u = byUser[k];
            u.days.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
            return u;
        }).sort(function (a, b) { return uName(a.userId).localeCompare(uName(b.userId), 'es'); });
    }

    function renderHours() {
        var filter = ($('#wh-h-filter').value || '').toLowerCase();
        var rows = hoursByUser().filter(function (u) { return matches(uName(u.userId) + ' ' + uLegajo(u.userId), filter); });
        var tot = rows.reduce(function (a, u) { a.out += u.outside; a.cli += u.client; a.n++; return a; }, { out: 0, cli: 0, n: 0 });
        var pend = items.filter(function (it) { return !S.hasCrew(it.rec); }).length;
        $('#wh-kpis').innerHTML = [
            ['Operarios', tot.n],
            ['Horas fuera de oficina', S.fmtDuration(tot.out)],
            ['Horas en clientes', S.fmtDuration(tot.cli)],
            ['Jornadas sin tripulación', pend]
        ].map(function (k) { return '<div class="wh-kpi"><span>' + esc(k[0]) + '</span><b>' + esc(k[1]) + '</b></div>'; }).join('');

        var html = '';
        rows.forEach(function (u) {
            var open = openUser === u.userId;
            html += '<tr class="wh-row-click' + (open ? ' is-open' : '') + '" data-user="' + esc(u.userId) + '">'
                + '<td><span class="wh-caret">' + (open ? '▾' : '▸') + '</span> ' + esc(uName(u.userId)) + '</td>'
                + '<td>' + esc(uLegajo(u.userId)) + '</td>'
                + '<td class="wh-num">' + u.days.length + '</td>'
                + '<td class="wh-num"><b>' + S.fmtDuration(u.outside) + '</b></td>'
                + '<td class="wh-num">' + S.fmtDuration(u.driving) + '</td>'
                + '<td class="wh-num">' + S.fmtDuration(u.riding) + '</td>'
                + '<td class="wh-num">' + S.fmtDuration(u.client) + '</td>'
                + '<td class="wh-num">' + (u.pending ? '<span class="wh-badge wh-badge-warn">' + u.pending + '</span>' : '') + '</td></tr>';
            if (open) {
                u.days.forEach(function (d) {
                    html += '<tr class="wh-sub-row"><td colspan="2">' + fmtDate(d.date) + ' · '
                        + esc(d.vehicles.map(dName).join(', ')) + '</td><td></td>'
                        + '<td class="wh-num">' + S.fmtDuration(d.outside) + '</td>'
                        + '<td class="wh-num">' + S.fmtDuration(d.driving) + '</td>'
                        + '<td class="wh-num">' + S.fmtDuration(d.riding) + '</td>'
                        + '<td class="wh-num">' + S.fmtDuration(d.client) + '</td><td></td></tr>';
                });
            }
        });
        $('#wh-hours').innerHTML = html;
        $('#wh-hours-empty').hidden = !!rows.length;
    }

    function exportHours() {
        var rows = [['Fecha', 'Operario', 'Legajo', 'Vehículos', 'Horas fuera de oficina', 'Horas manejando', 'Horas acompañando', 'Horas en clientes']];
        hoursByUser().forEach(function (u) {
            u.days.forEach(function (d) {
                rows.push([d.date, uName(u.userId), uLegajo(u.userId), d.vehicles.map(dName).join(', '),
                    S.hoursDecimal(d.outside), S.hoursDecimal(d.driving), S.hoursDecimal(d.riding), S.hoursDecimal(d.client)]);
            });
        });
        download('horas_' + range.from + '_' + range.to + '.csv', S.csv(rows));
    }

    // ------------------------------------------------------------------
    // Pestaña Jornadas
    // ------------------------------------------------------------------
    function crewText(it) {
        if (!it.rec) { return ''; }
        var names = (it.rec.members || []).map(function (m) {
            return (m.name || uName(m.userId)) + (m.to ? ' (hasta ' + S.hhmm(m.to) + ')' : '');
        });
        return names.length ? names.join(', ') : (it.rec.solo ? 'Solo' : '');
    }

    function missingStops(it) {
        var n = 0;
        S.stopsToAsk(it.timeline).forEach(function (s) { if (!S.stopEntry(it.rec, s.tripId) && !s.zone) { n++; } });
        return n;
    }

    function jornadaRows() {
        var filter = ($('#wh-j-filter').value || '').toLowerCase();
        var st = $('#wh-j-state').value;
        return items.filter(function (it) {
            var loaded = S.hasCrew(it.rec);
            if (st === 'pending' && loaded) { return false; }
            if (st === 'loaded' && !loaded) { return false; }
            if (st === 'stops' && !missingStops(it)) { return false; }
            return matches(dName(it.jornada.deviceId) + ' ' + uName(it.jornada.driverId) + ' ' + crewText(it), filter);
        }).sort(function (a, b) { return b.jornada.firstAt - a.jornada.firstAt; });
    }

    function renderJornadas() {
        var rows = jornadaRows();
        $('#wh-jornadas').innerHTML = rows.map(function (it) {
            var j = it.jornada, tl = it.timeline;
            var loaded = S.hasCrew(it.rec);
            var miss = missingStops(it);
            var status = !loaded ? '<span class="wh-badge wh-badge-warn">Sin cargar</span>'
                : (it.rec.status === 'closed' ? '<span class="wh-badge wh-badge-ok">Cerrada</span>' : '<span class="wh-badge">Abierta</span>');
            return '<tr>'
                + '<td>' + fmtDate(j.date) + '</td>'
                + '<td>' + esc(dName(j.deviceId)) + '</td>'
                + '<td>' + esc(uName(j.driverId)) + '</td>'
                + '<td class="wh-wrap">' + esc(crewText(it)) + '</td>'
                + '<td>' + S.hhmm(tl.firstStart) + '</td>'
                + '<td>' + S.hhmm(tl.lastStop) + '</td>'
                + '<td class="wh-num">' + (tl.firstStart == null ? '<span class="wh-muted">sin viajes</span>' : S.fmtDuration(S.total(tl.outside))) + '</td>'
                + '<td class="wh-num">' + (miss ? '<span class="wh-badge wh-badge-warn">' + miss + '</span>' : '') + '</td>'
                + '<td>' + status + (it.rec && it.rec.source === 'panel' ? ' <span class="wh-muted" title="Cargada o corregida desde la oficina">✎</span>' : '') + '</td>'
                + '<td class="wh-col-actions"><button class="wh-btn wh-btn-sm wh-btn-ghost" data-edit="' + esc(j.key) + '">Editar</button></td>'
                + '</tr>';
        }).join('');
        $('#wh-jornadas-empty').hidden = !!rows.length;
        $('#wh-jornadas-count').textContent = rows.length ? rows.length + ' jornada(s)' : '';
    }

    function exportJornadas() {
        var rows = [['Fecha', 'Vehículo', 'Chofer', 'Acompañantes', 'Salida', 'Regreso', 'Horas fuera de oficina', 'Paradas sin cliente', 'Estado']];
        jornadaRows().forEach(function (it) {
            var tl = it.timeline;
            rows.push([it.jornada.date, dName(it.jornada.deviceId), uName(it.jornada.driverId), crewText(it),
                S.hhmm(tl.firstStart), S.hhmm(tl.lastStop), S.hoursDecimal(S.total(tl.outside)), missingStops(it),
                !S.hasCrew(it.rec) ? 'Sin cargar' : (it.rec.status === 'closed' ? 'Cerrada' : 'Abierta')]);
        });
        download('jornadas_' + range.from + '_' + range.to + '.csv', S.csv(rows));
    }

    // ------------------------------------------------------------------
    // Edición de una jornada (modal)
    // ------------------------------------------------------------------
    var draft = null;

    function timeVal(isoStr) { return isoStr ? S.hhmm(isoStr) : ''; }
    function fromTime(date, hm) {
        if (!hm) { return null; }
        var p = hm.split(':'), d = new Date(S.dayStart(date));
        d.setHours(parseInt(p[0], 10), parseInt(p[1], 10), 0, 0);
        return d.toISOString();
    }

    function openEdit(key) {
        var it = items.filter(function (x) { return x.jornada.key === key; })[0];
        if (!it) { return; }
        modalKey = key;
        draft = it.rec ? S.clone(it.rec) : S.newCrewRecord(it.jornada, {
            deviceName: dName(it.jornada.deviceId), driverName: uName(it.jornada.driverId), by: session.userName, source: 'panel'
        });
        if (it.rec) { draft._id = it.rec._id; }
        $('#wh-modal-title').textContent = dName(it.jornada.deviceId) + ' · ' + fmtDate(it.jornada.date) + ' · ' + uName(it.jornada.driverId);
        renderModal();
        $('#wh-modal').hidden = false;
    }

    function operatorOptions(selected) {
        var ops = S.operatorsFrom(Object.keys(users).map(function (k) { return users[k]; }), groups, settings);
        if (selected && !ops.some(function (o) { return o.id === selected; })) { ops.unshift({ id: selected, name: uName(selected) }); }
        return '<option value="">Elegí un operario…</option>' + ops.map(function (o) {
            return '<option value="' + esc(o.id) + '"' + (o.id === selected ? ' selected' : '') + '>' + esc(o.name) + '</option>';
        }).join('');
    }

    function renderModal() {
        var it = items.filter(function (x) { return x.jornada.key === modalKey; })[0];
        if (!it || !draft) { return; }
        var tl = it.timeline;
        var html = '<div class="wh-form">';
        html += '<p class="wh-muted">Identificación: ' + S.hhmm(it.jornada.firstAt)
            + (tl.firstStart != null ? ' · Salida ' + S.hhmm(tl.firstStart) + ' · Regreso ' + S.hhmm(tl.lastStop)
                + ' · Fuera de oficina ' + S.fmtDuration(S.total(tl.outside)) : ' · sin viajes registrados') + '</p>';

        html += '<h3>Acompañantes</h3>';
        html += '<label class="wh-check"><input type="checkbox" id="wh-m-solo"' + (draft.solo ? ' checked' : '') + '> Viajó solo</label>';
        html += '<table class="wh-table wh-table-tight"><thead><tr><th>Operario</th><th>Desde</th><th>Hasta</th><th></th></tr></thead><tbody>';
        (draft.members || []).forEach(function (m, i) {
            html += '<tr><td><select data-m-user="' + i + '">' + operatorOptions(m.userId) + '</select></td>'
                + '<td><input type="time" data-m-from="' + i + '" value="' + timeVal(m.from) + '"></td>'
                + '<td><input type="time" data-m-to="' + i + '" value="' + timeVal(m.to) + '" title="Vacío = hasta el final de la jornada"></td>'
                + '<td><button class="wh-btn wh-btn-sm wh-btn-danger" data-m-del="' + i + '">Quitar</button></td></tr>';
        });
        html += '</tbody></table><button class="wh-btn wh-btn-sm wh-btn-ghost" data-m-add>+ Agregar acompañante</button>';

        var ask = S.stopsToAsk(tl);
        html += '<h3>Paradas y clientes</h3>';
        if (!ask.length) { html += '<p class="wh-muted">Sin paradas de más de ' + settings.minStopMinutes + ' min fuera de la base.</p>'; }
        else {
            html += '<table class="wh-table wh-table-tight"><thead><tr><th>Horario</th><th>Duración</th><th>Geocerca</th><th>Cliente</th><th>Sin cliente</th></tr></thead><tbody>';
            ask.forEach(function (s, i) {
                var e = S.stopEntry(draft, s.tripId);
                var val = e && e.clients && e.clients[0] || '';
                html += '<tr><td>' + S.hhmm(s.from) + '–' + S.hhmm(s.to) + '</td><td>' + S.fmtDuration(s.duration) + '</td>'
                    + '<td>' + esc(s.zone ? s.zone.name : '—') + '</td>'
                    + '<td><input type="text" list="wh-client-list" data-s-client="' + i + '" value="' + esc(val) + '" placeholder="' + esc(s.zone ? s.zone.name : 'Cliente') + '"></td>'
                    + '<td class="wh-center"><input type="checkbox" data-s-none="' + i + '"' + (e && e.noClient ? ' checked' : '') + '></td></tr>';
            });
            html += '</tbody></table><p class="wh-muted">Si el cliente queda vacío y la parada cae en una geocerca, se toma la geocerca.</p>';
        }

        html += '<h3>Estado</h3><select id="wh-m-status"><option value="open"' + (draft.status !== 'closed' ? ' selected' : '') + '>Abierta</option>'
            + '<option value="closed"' + (draft.status === 'closed' ? ' selected' : '') + '>Cerrada</option></select>';

        if ((draft.history || []).length) {
            html += '<h3>Historial</h3><ul class="wh-history">' + draft.history.slice().reverse().map(function (h) {
                return '<li><b>' + esc(new Date(h.at).toLocaleString('es-AR')) + '</b> · ' + esc(h.by) + ' · ' + esc(h.action) + (h.detail ? ' · ' + esc(h.detail) : '') + '</li>';
            }).join('') + '</ul>';
        }
        html += '<div class="wh-form-actions"><button class="wh-btn wh-btn-ghost" data-close>Cancelar</button><button class="wh-btn" id="wh-m-save">Guardar</button></div></div>';
        $('#wh-modal-body').innerHTML = html;
    }

    /** Pasa lo escrito en el modal al borrador (antes de agregar/quitar filas o guardar). */
    function readModal() {
        var it = items.filter(function (x) { return x.jornada.key === modalKey; })[0];
        var date = it.jornada.date;
        draft.solo = $('#wh-m-solo').checked;
        (draft.members || []).forEach(function (m, i) {
            var uid = $('[data-m-user="' + i + '"]').value;
            if (uid !== m.userId) { m.userId = uid; m.name = uName(uid); }
            m.from = fromTime(date, $('[data-m-from="' + i + '"]').value) || S.iso(it.jornada.firstAt);
            m.to = fromTime(date, $('[data-m-to="' + i + '"]').value);
        });
        var ask = S.stopsToAsk(it.timeline);
        ask.forEach(function (s, i) {
            var val = ($('[data-s-client="' + i + '"]').value || '').trim();
            var none = $('[data-s-none="' + i + '"]').checked;
            var e = S.stopEntry(draft, s.tripId);
            if (!val && !none) {
                if (e) { draft.stops = draft.stops.filter(function (x) { return x !== e; }); }
                return;
            }
            if (!e) { e = { tripId: s.tripId }; draft.stops.push(e); }
            e.from = S.iso(s.from); e.to = S.iso(s.to);
            e.zoneId = s.zone ? s.zone.id : null; e.zoneName = s.zone ? s.zone.name : null;
            e.noClient = none; e.clients = none ? [] : [val];
            e.by = session.userName; e.at = S.iso(Date.now());
        });
        draft.status = $('#wh-m-status').value;
    }

    function saveModal() {
        readModal();
        var bad = (draft.members || []).filter(function (m) { return !m.userId; });
        if (bad.length) { showMsg('Hay acompañantes sin operario elegido.', 'error'); return; }
        var dup = {};
        for (var i = 0; i < draft.members.length; i++) {
            var m = draft.members[i];
            if (m.to && m.from && m.to <= m.from) { showMsg(m.name + ': la hora "hasta" debe ser posterior a "desde".', 'error'); return; }
            if (dup[m.userId] && !dup[m.userId].to) { showMsg(m.name + ' figura dos veces sin hora de bajada.', 'error'); return; }
            dup[m.userId] = m;
        }
        if (draft.status === 'closed' && !draft.closedAt) { draft.closedAt = S.iso(Date.now()); draft.closedBy = session.userName; }
        if (draft.status !== 'closed') { draft.closedAt = null; draft.closedBy = null; }
        draft.source = 'panel';
        S.addHistory(draft, session.userName, 'oficina', 'edición desde MyGeotab');
        var btn = $('#wh-m-save');
        btn.disabled = true;
        store.save(draft).then(function (saved) {
            items.forEach(function (it) { if (it.jornada.key === modalKey) { it.rec = saved; } });
            closeModal();
            recompute();
            renderAll();
            showMsg('Jornada guardada.', 'ok');
        }).catch(function (e) {
            btn.disabled = false;
            showMsg('No se pudo guardar: ' + errText(e), 'error');
        });
    }

    function closeModal() { $('#wh-modal').hidden = true; modalKey = null; draft = null; }

    // ------------------------------------------------------------------
    // Pestaña Clientes
    // ------------------------------------------------------------------
    function visitRows() {
        var filter = ($('#wh-c-filter').value || '').toLowerCase();
        var src = $('#wh-c-source').value;
        return visits.filter(function (v) {
            if (src === 'confirmed' && !v.confirmed) { return false; }
            if (src === 'zone' && v.confirmed) { return false; }
            return matches(v.client + ' ' + dName(v.deviceId) + ' ' + v.people.map(uName).join(' '), filter);
        });
    }

    function renderClients() {
        var rows = visitRows();
        var sum = {};
        rows.forEach(function (v) {
            var s = sum[v.client] || (sum[v.client] = { client: v.client, n: 0, time: 0, personTime: 0, last: 0 });
            s.n++; s.time += v.duration; s.personTime += v.duration * Math.max(1, v.people.length); s.last = Math.max(s.last, v.from);
        });
        $('#wh-client-sum').innerHTML = Object.keys(sum).map(function (k) { return sum[k]; })
            .sort(function (a, b) { return b.time - a.time; }).map(function (s) {
                return '<tr><td>' + esc(s.client) + '</td><td class="wh-num">' + s.n + '</td><td class="wh-num">' + S.fmtDuration(s.time)
                    + '</td><td class="wh-num">' + S.fmtDuration(s.personTime) + '</td><td>' + fmtDate(S.dayKey(s.last)) + '</td></tr>';
            }).join('');
        $('#wh-visits').innerHTML = rows.map(function (v) {
            return '<tr><td>' + fmtDate(v.date) + '</td><td>' + esc(v.client) + '</td><td>' + esc(dName(v.deviceId)) + '</td>'
                + '<td>' + S.hhmm(v.from) + '</td><td>' + S.hhmm(v.to) + '</td><td class="wh-num">' + S.fmtDuration(v.duration) + '</td>'
                + '<td class="wh-wrap">' + esc(v.people.map(uName).join(', ')) + '</td>'
                + '<td>' + (v.confirmed ? 'Chofer' : '<span class="wh-muted">Geocerca</span>') + '</td></tr>';
        }).join('');
        $('#wh-visits-empty').hidden = !!rows.length;
    }

    function exportClients() {
        var rows = [['Fecha', 'Cliente', 'Vehículo', 'Desde', 'Hasta', 'Horas', 'Personas', 'Cantidad de personas', 'Origen']];
        visitRows().forEach(function (v) {
            rows.push([v.date, v.client, dName(v.deviceId), S.hhmm(v.from), S.hhmm(v.to), S.hoursDecimal(v.duration),
                v.people.map(uName).join(', '), v.people.length, v.confirmed ? 'Chofer' : 'Geocerca']);
        });
        download('clientes_' + range.from + '_' + range.to + '.csv', S.csv(rows));
    }

    // ------------------------------------------------------------------
    // Pestaña Configuración
    // ------------------------------------------------------------------
    var zoneFilter = '';

    function groupTree(selected, attr) {
        var byId = {};
        groups.forEach(function (g) { byId[g.id] = g; });
        var sel = {};
        (selected || []).forEach(function (id) { sel[id] = true; });
        var out = [];
        function walk(id, depth, seen) {
            var g = byId[id];
            if (!g || seen[id]) { return; }
            seen[id] = true;
            if (depth > 0) {
                out.push('<label class="wh-check" style="padding-left:' + (depth - 1) * 18 + 'px"><input type="checkbox" ' + attr
                    + '="' + esc(g.id) + '"' + (sel[g.id] ? ' checked' : '') + '> ' + esc(g.name || g.id) + '</label>');
            }
            (g.children || []).forEach(function (c) { walk(S.idOf(c), depth + 1, seen); });
        }
        walk('GroupCompanyId', 0, {});
        return '<div class="wh-checklist">' + out.join('') + '</div>';
    }

    function zoneTypeName(id) {
        var t = zoneTypes.filter(function (z) { return z.id === id; })[0];
        return (t && t.name) || ZONE_TYPE_NAMES[id] || id;
    }

    function renderZoneList() {
        var sel = {};
        (settings.baseZoneIds || []).forEach(function (id) { sel[id] = true; });
        var f = zoneFilter.toLowerCase();
        var list = zones.filter(function (z) { return sel[z.id] || (f && z.name.toLowerCase().indexOf(f) >= 0); })
            .sort(function (a, b) { return (sel[b.id] ? 1 : 0) - (sel[a.id] ? 1 : 0) || a.name.localeCompare(b.name, 'es'); })
            .slice(0, 60);
        return list.map(function (z) {
            return '<label class="wh-check"><input type="checkbox" data-base-zone="' + esc(z.id) + '"' + (sel[z.id] ? ' checked' : '') + '> ' + esc(z.name) + '</label>';
        }).join('') || '<p class="wh-muted">Escribí parte del nombre para buscar zonas.</p>';
    }

    function renderSettings() {
        if (!refLoaded) {
            $('#wh-settings').innerHTML = '<p class="wh-empty">Consultá un período primero para cargar grupos y zonas.</p>';
            return;
        }
        var typeIds = {};
        zones.forEach(function (z) { z.types.forEach(function (t) { typeIds[t] = (typeIds[t] || 0) + 1; }); });
        var selTypes = {};
        (settings.clientZoneTypeIds || []).forEach(function (t) { selTypes[t] = true; });
        var html = '<div class="wh-settings-grid">'
            + '<div class="wh-card"><h3>Operarios</h3><p class="wh-muted">Grupos de conductores que aparecen como acompañantes (incluye subgrupos). Sin selección: todos los conductores activos.</p>'
            + groupTree(settings.operatorGroupIds, 'data-op-group') + '</div>'
            + '<div class="wh-card"><h3>Grupos excluidos</h3><p class="wh-muted">Llaves que no son personas (mantenimiento, sin asignar). No generan jornada y cortan la del chofer anterior.</p>'
            + groupTree(settings.excludeGroupIds, 'data-ex-group') + '</div>'
            + '<div class="wh-card"><h3>Zonas base / oficina</h3><p class="wh-muted">El tiempo detenido dentro de estas zonas no cuenta como "fuera de oficina".</p>'
            + '<input type="search" id="wh-zone-search" placeholder="Buscar zona…" value="' + esc(zoneFilter) + '" autocomplete="off">'
            + '<div class="wh-checklist" id="wh-zone-list">' + renderZoneList() + '</div></div>'
            + '<div class="wh-card"><h3>Tipos de zona de cliente</h3><p class="wh-muted">Qué geocercas se sugieren como cliente en las paradas. Sin selección: cualquier zona que no sea base.</p><div class="wh-checklist">'
            + Object.keys(typeIds).sort(function (a, b) { return zoneTypeName(a).localeCompare(zoneTypeName(b), 'es'); }).map(function (t) {
                return '<label class="wh-check"><input type="checkbox" data-ztype="' + esc(t) + '"' + (selTypes[t] ? ' checked' : '') + '> '
                    + esc(zoneTypeName(t)) + ' <span class="wh-muted">(' + typeIds[t] + ')</span></label>';
            }).join('') + '</div></div>'
            + '<div class="wh-card"><h3>Paradas y avisos</h3>'
            + '<label class="wh-field">Parada mínima a informar (minutos) <input type="number" id="wh-s-minstop" min="1" max="240" value="' + esc(settings.minStopMinutes) + '"></label>'
            + '<label class="wh-field">Revisión en Drive cada (minutos) <input type="number" id="wh-s-poll" min="1" max="30" value="' + esc(settings.pollMinutes) + '"></label></div>'
            + '<div class="wh-card"><h3>Clientes sin geocerca</h3><p class="wh-muted">Uno por línea. Aparecen como opciones en Drive.</p>'
            + '<textarea id="wh-s-clients" rows="8">' + esc((settings.clients || []).join('\n')) + '</textarea></div>'
            + '</div><div class="wh-form-actions"><span class="wh-muted">' + (settings._id ? '' : 'Todavía no se guardó ninguna configuración (se usan los valores por defecto).') + '</span>'
            + '<button class="wh-btn" id="wh-s-save">Guardar configuración</button></div>';
        $('#wh-settings').innerHTML = html;
    }

    function checkedValues(attr) {
        return Array.prototype.slice.call(root.querySelectorAll('[' + attr + ']:checked')).map(function (el) { return el.getAttribute(attr); });
    }

    function saveSettings() {
        var base = {};
        (settings.baseZoneIds || []).forEach(function (id) { base[id] = true; });
        root.querySelectorAll('[data-base-zone]').forEach(function (el) {
            var id = el.getAttribute('data-base-zone');
            if (el.checked) { base[id] = true; } else { delete base[id]; }
        });
        var s = S.clone(settings);
        s.operatorGroupIds = checkedValues('data-op-group');
        s.excludeGroupIds = checkedValues('data-ex-group');
        s.baseZoneIds = Object.keys(base);
        s.clientZoneTypeIds = checkedValues('data-ztype');
        s.minStopMinutes = Math.max(1, parseInt($('#wh-s-minstop').value, 10) || 10);
        s.pollMinutes = Math.max(1, parseInt($('#wh-s-poll').value, 10) || 2);
        s.clients = ($('#wh-s-clients').value || '').split(/\r?\n/).map(function (c) { return c.trim(); })
            .filter(function (c, i, arr) { return c && arr.indexOf(c) === i; });
        $('#wh-s-save').disabled = true;
        store.save(S.settingsRecord(s, session.userName)).then(function (saved) {
            settings = Object.assign(S.clone(S.DEFAULT_SETTINGS), s, { _id: saved._id });
            showMsg('Configuración guardada. Volvé a consultar para recalcular con los cambios.', 'ok');
            renderSettings();
        }).catch(function (e) {
            $('#wh-s-save').disabled = false;
            showMsg('No se pudo guardar: ' + errText(e), 'error');
        });
    }

    // ------------------------------------------------------------------
    // Render general y eventos
    // ------------------------------------------------------------------
    function renderAll() {
        renderHours();
        renderJornadas();
        renderClients();
        if (tab === 'settings') { renderSettings(); }
    }

    function showTab(name) {
        tab = name;
        root.querySelectorAll('.wh-tab').forEach(function (b) { b.classList.toggle('is-active', b.getAttribute('data-tab') === name); });
        ['hours', 'jornadas', 'clients', 'settings'].forEach(function (t) { $('#wh-tab-' + t).hidden = t !== name; });
        if (name === 'settings') { renderSettings(); }
    }

    function bindEvents() {
        root.querySelectorAll('.wh-tab').forEach(function (b) {
            b.addEventListener('click', function () { showTab(b.getAttribute('data-tab')); });
        });
        $('#wh-load').addEventListener('click', function () { if (!busy) { load(); } });
        $('#wh-h-filter').addEventListener('input', renderHours);
        $('#wh-j-filter').addEventListener('input', renderJornadas);
        $('#wh-j-state').addEventListener('change', renderJornadas);
        $('#wh-c-filter').addEventListener('input', renderClients);
        $('#wh-c-source').addEventListener('change', renderClients);
        $('#wh-h-export').addEventListener('click', exportHours);
        $('#wh-j-export').addEventListener('click', exportJornadas);
        $('#wh-c-export').addEventListener('click', exportClients);
        $('#wh-hours').addEventListener('click', function (e) {
            var tr = e.target.closest('tr[data-user]');
            if (!tr) { return; }
            var id = tr.getAttribute('data-user');
            openUser = openUser === id ? null : id;
            renderHours();
        });
        $('#wh-jornadas').addEventListener('click', function (e) {
            var b = e.target.closest('[data-edit]');
            if (b) { openEdit(b.getAttribute('data-edit')); }
        });
        $('#wh-modal').addEventListener('click', function (e) {
            if (e.target.hasAttribute('data-close') || e.target.id === 'wh-modal') { closeModal(); return; }
            if (e.target.hasAttribute('data-m-add')) {
                readModal();
                var it = items.filter(function (x) { return x.jornada.key === modalKey; })[0];
                draft.members.push({ userId: '', name: '', from: S.iso(it.jornada.firstAt), to: null, addedBy: session.userName, addedAt: S.iso(Date.now()) });
                draft.solo = false;
                renderModal();
                return;
            }
            var del = e.target.getAttribute('data-m-del');
            if (del != null) { readModal(); draft.members.splice(parseInt(del, 10), 1); renderModal(); return; }
            if (e.target.id === 'wh-m-save') { saveModal(); }
        });
        $('#wh-settings').addEventListener('click', function (e) {
            if (e.target.id === 'wh-s-save') { saveSettings(); }
        });
        $('#wh-settings').addEventListener('change', function (e) {
            var id = e.target.getAttribute('data-base-zone');
            if (id == null) { return; }
            var list = settings.baseZoneIds || [];
            if (e.target.checked && list.indexOf(id) < 0) { list.push(id); }
            if (!e.target.checked) { list = list.filter(function (x) { return x !== id; }); }
            settings.baseZoneIds = list;
        });
        $('#wh-settings').addEventListener('input', function (e) {
            if (e.target.id !== 'wh-zone-search') { return; }
            zoneFilter = e.target.value;
            $('#wh-zone-list').innerHTML = renderZoneList();
        });
        document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !$('#wh-modal').hidden) { closeModal(); } });
    }

    // ------------------------------------------------------------------
    // Ciclo de vida
    // ------------------------------------------------------------------
    var bound = false;

    return {
        initialize: function (freshApi, freshState, callback) {
            api = freshApi;
            root = document.getElementById('workingHours');
            store = new S.Store(call, multiCall);
            if (!bound) {
                bindEvents();
                bound = true;
                var to = S.dayKey(Date.now());
                $('#wh-to').value = to;
                $('#wh-from').value = S.addDays(to, -6);
            }
            var done = false;
            function finish() { if (!done) { done = true; callback(); } }
            try {
                api.getSession(function (s) { session.userName = s && s.userName ? s.userName : ''; finish(); });
            } catch (e) { finish(); }
            setTimeout(finish, 5000);
        },
        focus: function (freshApi) {
            api = freshApi;
            store = new S.Store(call, multiCall);
            if (!items.length && !busy) { load(); }
        },
        blur: function () { closeModal(); }
    };
};
