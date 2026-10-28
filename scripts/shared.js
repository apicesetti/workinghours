/**
 * Horas de trabajo — lógica compartida entre el add-in de Geotab Drive y la página de MyGeotab.
 *
 * Conceptos
 *   Identificación  DriverChange de una persona (llavero NFC o GO Focus). Se ignoran
 *                   "UnknownDriverId" (se genera al apagar el vehículo) y las personas de los
 *                   grupos excluidos (p. ej. llaves de mantenimiento): estas cortan el tramo.
 *   Jornada         chofer + vehículo + día local. Puede tener varios tramos si otra persona
 *                   usó el vehículo en el medio. Clave: "AAAA-MM-DD|deviceId|driverId".
 *   Tripulación     registro AddInData (type "crew") con los acompañantes de una jornada y
 *                   los clientes de cada parada.
 *   Horas fuera     desde el inicio del primer viaje hasta el fin del último viaje de la
 *                   jornada, descontando las paradas intermedias dentro de una zona Base.
 *
 * AddInData: details = { type, date, key, rec }. "rec" es el registro completo; los campos de
 * primer nivel existen solo para poder filtrar con whereClause (una condición, sin AND/OR).
 *
 * Funciona en el navegador (window.WorkingHoursShared) y en Node (module.exports) para tests.
 * Ingeniero Jorge Cesetti SRL
 */
(function (root, factory) {
    'use strict';
    var lib = factory();
    if (typeof module === 'object' && module.exports) { module.exports = lib; }
    else { root.WorkingHoursShared = lib; }
}(typeof self !== 'undefined' ? self : this, function () {
    'use strict';

    var ADDIN_ID = 'aETg6OS_TD0uqoFHaLelHvg';
    var VERSION = '1.0.0';
    var CREW = 'crew';
    var SETTINGS = 'settings';
    var UNKNOWN_DRIVER = 'UnknownDriverId';
    var MAX_DETAILS_CHARS = 9500;          // límite de AddInData: 10.000 caracteres
    var MAX_HISTORY = 25;
    var MIN = 60000;
    var DAY = 86400000;

    var DEFAULT_SETTINGS = {
        operatorGroupIds: [],      // vacío = todos los conductores activos
        excludeGroupIds: [],       // p. ej. "Llaves de mantenimiento", "Llaves sin asignar"
        baseZoneIds: [],           // zonas que cuentan como oficina/base
        clientZoneTypeIds: [],     // vacío = cualquier zona que no sea base se propone como cliente
        minStopMinutes: 10,        // paradas más cortas no se piden ni se cuentan como visita
        pollMinutes: 2,            // cada cuánto revisa el add-in de Drive si hubo una identificación
        clients: []                // catálogo de clientes sin geocerca
    };

    // ------------------------------------------------------------------
    // Utilidades generales
    // ------------------------------------------------------------------
    function esc(v) {
        return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }

    function clone(o) { return o == null ? o : JSON.parse(JSON.stringify(o)); }

    function toMs(v) {
        if (v == null || v === '') { return null; }
        if (typeof v === 'number') { return v; }
        var t = new Date(v).getTime();
        return isNaN(t) ? null : t;
    }

    function iso(ms) { return ms == null ? null : new Date(ms).toISOString(); }

    /** TimeSpan de .NET ("hh:mm:ss", "hh:mm:ss.fffffff" o "d.hh:mm:ss") → milisegundos. */
    function parseTimeSpan(s) {
        if (s == null || s === '') { return 0; }
        if (typeof s === 'number') { return s; }
        var m = /^(-)?(?:(\d+)\.)?(\d+):(\d+):(\d+)(?:\.(\d+))?$/.exec(String(s).trim());
        if (!m) { return 0; }
        var frac = m[6] ? parseFloat('0.' + m[6]) : 0;
        var ms = (((parseInt(m[2] || '0', 10) * 24 + parseInt(m[3], 10)) * 60 + parseInt(m[4], 10)) * 60
            + parseInt(m[5], 10) + frac) * 1000;
        return Math.round(m[1] ? -ms : ms);
    }

    function pad(n) { return (n < 10 ? '0' : '') + n; }

    /** Día local "AAAA-MM-DD" de un instante. */
    function dayKey(v) {
        var d = new Date(toMs(v));
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    /** Medianoche local del día "AAAA-MM-DD" (ms). */
    function dayStart(key) {
        var p = String(key).split('-');
        return new Date(parseInt(p[0], 10), parseInt(p[1], 10) - 1, parseInt(p[2], 10)).getTime();
    }

    function dayEnd(key) {
        var s = new Date(dayStart(key));
        return new Date(s.getFullYear(), s.getMonth(), s.getDate() + 1).getTime();
    }

    /** Lista de días entre dos claves inclusive. */
    function daysBetween(fromKey, toKey) {
        var out = [], t = dayStart(fromKey), end = dayStart(toKey), guard = 0;
        while (t <= end && guard++ < 400) {
            out.push(dayKey(t));
            var d = new Date(t);
            t = new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1).getTime();
        }
        return out;
    }

    function addDays(key, n) {
        var d = new Date(dayStart(key));
        return dayKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + n).getTime());
    }

    function hhmm(v) {
        var ms = toMs(v);
        if (ms == null) { return '—'; }
        var d = new Date(ms);
        return pad(d.getHours()) + ':' + pad(d.getMinutes());
    }

    /** Duración en ms → "7 h 05 min" / "45 min". */
    function fmtDuration(ms) {
        if (!ms || ms < 0) { return '0 min'; }
        var mins = Math.round(ms / MIN);
        var h = Math.floor(mins / 60), m = mins % 60;
        return h ? h + ' h ' + pad(m) + ' min' : m + ' min';
    }

    /** Duración en ms → horas decimales con 2 decimales (para CSV). */
    function hoursDecimal(ms) { return (Math.round((ms || 0) / 36000) / 100).toFixed(2); }

    function idOf(ref) {
        if (!ref) { return null; }
        if (typeof ref === 'string') { return ref; }
        return ref.id || null;
    }

    function userName(u) {
        if (!u) { return ''; }
        var full = ((u.firstName || '') + ' ' + (u.lastName || '')).trim();
        return full || u.name || u.id || '';
    }

    // ------------------------------------------------------------------
    // Grupos
    // ------------------------------------------------------------------
    /** Conjunto con los ids indicados y todos sus subgrupos. */
    function expandGroups(groups, ids) {
        var byId = {}, out = {}, stack = (ids || []).slice();
        (groups || []).forEach(function (g) { byId[g.id] = g; });
        while (stack.length) {
            var id = stack.pop();
            if (!id || out[id]) { continue; }
            out[id] = true;
            var g = byId[id];
            (g && g.children || []).forEach(function (c) { stack.push(idOf(c)); });
        }
        return out;
    }

    function userInGroups(user, groupSet) {
        var gs = (user && user.driverGroups) || [];
        for (var i = 0; i < gs.length; i++) { if (groupSet[idOf(gs[i])]) { return true; } }
        return false;
    }

    function isActive(entity, now) {
        var t = toMs(entity && entity.activeTo);
        return t == null || t > (now || Date.now());
    }

    /**
     * Operarios elegibles como acompañantes: conductores activos, dentro de los grupos de
     * operarios (si se configuraron) y fuera de los grupos excluidos.
     */
    function operatorsFrom(users, groups, settings, now) {
        var s = settings || DEFAULT_SETTINGS;
        var incl = (s.operatorGroupIds || []).length ? expandGroups(groups, s.operatorGroupIds) : null;
        var excl = expandGroups(groups, s.excludeGroupIds || []);
        return (users || []).filter(function (u) {
            if (!u || u.isDriver === false || !isActive(u, now)) { return false; }
            if (userInGroups(u, excl)) { return false; }
            return !incl || userInGroups(u, incl);
        }).map(function (u) {
            return { id: u.id, name: userName(u), login: u.name || '', employeeNo: u.employeeNo || '' };
        }).sort(function (a, b) { return a.name.localeCompare(b.name, 'es'); });
    }

    // ------------------------------------------------------------------
    // Jornadas a partir de DriverChange
    // ------------------------------------------------------------------
    /**
     * @param changes  DriverChange[] (cualquier tipo: DriverKey, TripDriver, …)
     * @param opts     { isExcluded(driverId) → bool, now: ms }
     * @returns        jornadas ordenadas: { key, date, deviceId, driverId, firstAt, segments:[{from,to}] }
     *
     * Por vehículo y día se recorre la secuencia ordenada de identificaciones:
     *   - UnknownDriverId (llavero retirado / contacto apagado) no corta el tramo.
     *   - Otra persona, o una llave excluida, corta el tramo actual.
     *   - El último tramo termina a la medianoche (o "now" si el día es hoy).
     */
    function buildJornadas(changes, opts) {
        opts = opts || {};
        var isExcluded = opts.isExcluded || function () { return false; };
        var now = opts.now || Date.now();
        var perDeviceDay = {};

        (changes || []).forEach(function (c) {
            var t = toMs(c && c.dateTime);
            var dev = idOf(c && c.device);
            if (t == null || !dev) { return; }
            var drv = idOf(c.driver);
            var who;
            if (!drv || drv === UNKNOWN_DRIVER) { who = null; }            // no corta
            else if (isExcluded(drv)) { who = '#other'; }                  // corta, sin jornada
            else { who = drv; }
            var k = dayKey(t) + '|' + dev;
            (perDeviceDay[k] = perDeviceDay[k] || []).push({ t: t, who: who });
        });

        var jornadas = {};
        Object.keys(perDeviceDay).forEach(function (k) {
            var parts = k.split('|'), date = parts[0], dev = parts[1];
            var evts = perDeviceDay[k].filter(function (e) { return e.who; })
                .sort(function (a, b) { return a.t - b.t; });
            var end = Math.min(dayEnd(date), Math.max(now, dayStart(date)));
            var cur = null;
            evts.forEach(function (e) {
                if (cur && cur.who === e.who) { return; }
                if (cur) { cur.to = e.t; }
                cur = { who: e.who, from: e.t, to: null };
                if (e.who !== '#other') {
                    var jk = date + '|' + dev + '|' + e.who;
                    var j = jornadas[jk] || (jornadas[jk] = {
                        key: jk, date: date, deviceId: dev, driverId: e.who, firstAt: e.t, segments: []
                    });
                    j.segments.push(cur);
                }
            });
            if (cur && cur.to == null) { cur.to = Math.max(end, cur.from); }
        });

        return Object.keys(jornadas).map(function (k) {
            var j = jornadas[k];
            j.segments = j.segments.map(function (s) { return { from: s.from, to: s.to }; });
            return j;
        }).sort(function (a, b) { return a.firstAt - b.firstAt; });
    }

    function inSegments(t, segments) {
        for (var i = 0; i < segments.length; i++) {
            if (t >= segments[i].from && t < segments[i].to) { return true; }
        }
        return false;
    }

    // ------------------------------------------------------------------
    // Zonas
    // ------------------------------------------------------------------
    /** Versión compacta de una Zone para cachear y evaluar rápido. */
    function compactZone(z) {
        var pts = (z.points || []).map(function (p) { return [p.x, p.y]; });
        var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        pts.forEach(function (p) {
            if (p[0] < minX) { minX = p[0]; } if (p[0] > maxX) { maxX = p[0]; }
            if (p[1] < minY) { minY = p[1]; } if (p[1] > maxY) { maxY = p[1]; }
        });
        return {
            id: z.id, name: z.name || '',
            types: (z.zoneTypes || []).map(idOf),
            pts: pts, bbox: [minX, minY, maxX, maxY],
            area: (maxX - minX) * (maxY - minY)
        };
    }

    function pointInPolygon(x, y, pts) {
        var inside = false;
        for (var i = 0, j = pts.length - 1; i < pts.length; j = i++) {
            var xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
            if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / ((yj - yi) || 1e-12) + xi)) {
                inside = !inside;
            }
        }
        return inside;
    }

    /** Zonas compactas que contienen el punto {x: lon, y: lat}, de la más chica a la más grande. */
    function zonesAt(point, zones) {
        if (!point || point.x == null || point.y == null) { return []; }
        return (zones || []).filter(function (z) {
            var b = z.bbox;
            return z.pts.length > 2 && point.x >= b[0] && point.x <= b[2] && point.y >= b[1] && point.y <= b[3]
                && pointInPolygon(point.x, point.y, z.pts);
        }).sort(function (a, b) { return a.area - b.area; });
    }

    /**
     * Clasifica un punto: { base: bool, zone: zona de cliente sugerida | null }.
     * Una zona es de cliente si no es base y (no hay tipos configurados o tiene alguno de ellos).
     */
    function classifyPoint(point, zones, settings) {
        var s = settings || DEFAULT_SETTINGS;
        var baseIds = {}, types = {};
        (s.baseZoneIds || []).forEach(function (id) { baseIds[id] = true; });
        (s.clientZoneTypeIds || []).forEach(function (id) { types[id] = true; });
        var anyType = !(s.clientZoneTypeIds || []).length;
        var found = zonesAt(point, zones);
        var base = found.some(function (z) { return baseIds[z.id]; });
        var client = null;
        for (var i = 0; i < found.length && !client; i++) {
            var z = found[i];
            if (baseIds[z.id]) { continue; }
            if (anyType || z.types.some(function (t) { return types[t]; })) { client = z; }
        }
        return { base: base, zone: client ? { id: client.id, name: client.name } : null };
    }

    // ------------------------------------------------------------------
    // Intervalos [from, to) en ms
    // ------------------------------------------------------------------
    function union(list) {
        var arr = (list || []).filter(function (i) { return i && i.to > i.from; })
            .map(function (i) { return { from: i.from, to: i.to }; })
            .sort(function (a, b) { return a.from - b.from; });
        var out = [];
        arr.forEach(function (i) {
            var last = out[out.length - 1];
            if (last && i.from <= last.to) { last.to = Math.max(last.to, i.to); }
            else { out.push(i); }
        });
        return out;
    }

    function clip(list, from, to) {
        var a = from == null ? -Infinity : from, b = to == null ? Infinity : to;
        return (list || []).map(function (i) {
            return { from: Math.max(i.from, a), to: Math.min(i.to, b) };
        }).filter(function (i) { return i.to > i.from; });
    }

    function subtract(list, holes) {
        var out = union(list);
        union(holes).forEach(function (h) {
            var next = [];
            out.forEach(function (i) {
                if (h.to <= i.from || h.from >= i.to) { next.push(i); return; }
                if (h.from > i.from) { next.push({ from: i.from, to: h.from }); }
                if (h.to < i.to) { next.push({ from: h.to, to: i.to }); }
            });
            out = next;
        });
        return out;
    }

    function total(list) {
        return union(list).reduce(function (s, i) { return s + (i.to - i.from); }, 0);
    }

    // ------------------------------------------------------------------
    // Línea de tiempo de una jornada
    // ------------------------------------------------------------------
    /**
     * @param jornada  de buildJornadas
     * @param trips    Trip[] del vehículo (se filtran los que empiezan dentro de la jornada)
     * @param ctx      { zones: zonas compactas, settings }
     * @returns {
     *   trips, firstStart, lastStop,
     *   outside:[intervalos fuera de la base], driving:[intervalos manejando],
     *   stops:[{ tripId, from, to, duration, point, base, zone, final }]
     * }
     */
    function buildTimeline(jornada, trips, ctx) {
        ctx = ctx || {};
        var settings = ctx.settings || DEFAULT_SETTINGS;
        var zones = ctx.zones || [];
        var minStop = (settings.minStopMinutes || 0) * MIN;
        var list = (trips || []).filter(function (t) {
            return idOf(t.device) === jornada.deviceId && inSegments(toMs(t.start), jornada.segments);
        }).sort(function (a, b) { return toMs(a.start) - toMs(b.start); });

        var res = { trips: list, firstStart: null, lastStop: null, outside: [], driving: [], stops: [] };
        if (!list.length) { return res; }

        var segEnd = jornada.segments.reduce(function (m, s) { return Math.max(m, s.to); }, 0);
        res.firstStart = toMs(list[0].start);
        res.lastStop = toMs(list[list.length - 1].stop);

        var baseHoles = [];
        list.forEach(function (t, i) {
            var start = toMs(t.start), stop = toMs(t.stop);
            if (stop > start) { res.driving.push({ from: start, to: stop }); }
            var isLast = i === list.length - 1;
            var nextStart = isLast ? toMs(t.nextTripStart) : toMs(list[i + 1].start);
            var to = nextStart != null ? nextStart : stop + parseTimeSpan(t.stopDuration);
            if (isLast) { to = Math.min(to, segEnd); }
            var cls = classifyPoint(t.stopPoint, zones, settings);
            var stopRec = {
                tripId: t.id, from: stop, to: Math.max(stop, to), duration: Math.max(0, to - stop),
                point: t.stopPoint ? { x: t.stopPoint.x, y: t.stopPoint.y } : null,
                base: cls.base, zone: cls.zone, final: isLast
            };
            if (!isLast && cls.base) { baseHoles.push({ from: stopRec.from, to: stopRec.to }); }
            if (stopRec.duration >= minStop) { res.stops.push(stopRec); }
        });
        res.outside = subtract([{ from: res.firstStart, to: res.lastStop }], baseHoles);
        res.driving = union(res.driving);
        return res;
    }

    /** Paradas que el chofer debería completar: duración mínima, fuera de la base, no finales. */
    function stopsToAsk(timeline) {
        return (timeline.stops || []).filter(function (s) { return !s.base && !s.final; });
    }

    // ------------------------------------------------------------------
    // Registros de tripulación
    // ------------------------------------------------------------------
    function newCrewRecord(jornada, info) {
        info = info || {};
        var now = new Date().toISOString();
        return {
            type: CREW, version: 1,
            key: jornada.key, date: jornada.date,
            deviceId: jornada.deviceId, deviceName: info.deviceName || '',
            driverId: jornada.driverId, driverName: info.driverName || '',
            identifiedAt: iso(jornada.firstAt),
            solo: false,
            members: [],          // [{ userId, name, from, to, addedBy, addedAt }]
            stops: [],            // [{ tripId, from, to, zoneId, zoneName, clients:[], note, by, at }]
            status: 'open',       // open | closed
            closedAt: null, closedBy: null,
            createdAt: now, createdBy: info.by || '',
            updatedAt: now, updatedBy: info.by || '',
            source: info.source || '',
            history: []
        };
    }

    function addHistory(rec, by, action, detail) {
        rec.history = (rec.history || []).concat([{ at: new Date().toISOString(), by: by || '', action: action, detail: detail || '' }]);
        if (rec.history.length > MAX_HISTORY) { rec.history = rec.history.slice(-MAX_HISTORY); }
        rec.updatedAt = new Date().toISOString();
        rec.updatedBy = by || '';
        return rec;
    }

    /** Acompañantes vigentes (sin "to"). */
    function activeMembers(rec) {
        return ((rec && rec.members) || []).filter(function (m) { return !m.to; });
    }

    function hasCrew(rec) {
        return !!(rec && (rec.solo || (rec.members || []).length));
    }

    function stopEntry(rec, tripId) {
        var list = (rec && rec.stops) || [];
        for (var i = 0; i < list.length; i++) { if (list[i].tripId === tripId) { return list[i]; } }
        return null;
    }

    /** Envoltorio para AddInData (filtrable por type, date o key). */
    function wrap(rec) {
        return { type: rec.type, date: rec.date || '', key: rec.key || rec.type, rec: rec };
    }

    /**
     * AddInData → registro. Soporta resultados con selectClause "rec" (details = registro) y
     * sin selectClause (details = envoltorio).
     */
    function unwrap(entity) {
        var d = entity && entity.details;
        if (typeof d === 'string') { try { d = JSON.parse(d); } catch (e) { d = null; } }
        if (!d || typeof d !== 'object') { return null; }
        var rec = d.rec && typeof d.rec === 'object' ? d.rec : (d.type ? d : null);
        if (!rec || !rec.type) { return null; }
        rec = clone(rec);
        rec._id = entity.id;
        return rec;
    }

    /** Si el JSON excede el límite, recorta historial y notas. Devuelve el largo final. */
    function fitSize(rec) {
        function len() { return JSON.stringify(wrap(strip(rec))).length; }
        var n = len();
        while (n > MAX_DETAILS_CHARS && rec.history && rec.history.length > 3) {
            rec.history = rec.history.slice(Math.ceil(rec.history.length / 2));
            n = len();
        }
        if (n > MAX_DETAILS_CHARS) {
            (rec.stops || []).forEach(function (s) { s.note = (s.note || '').slice(0, 40); });
            n = len();
        }
        return n;
    }

    /** Copia sin campos locales (_id, _dirty, …). */
    function strip(rec) {
        var out = {};
        Object.keys(rec || {}).forEach(function (k) { if (k.charAt(0) !== '_') { out[k] = rec[k]; } });
        return out;
    }

    /** Ante duplicados por la misma clave se queda con el actualizado más recientemente. */
    function dedupe(records) {
        var byKey = {};
        (records || []).forEach(function (r) {
            if (!r || !r.key) { return; }
            var cur = byKey[r.key];
            if (!cur || String(r.updatedAt || '') > String(cur.updatedAt || '')) { byKey[r.key] = r; }
        });
        return Object.keys(byKey).map(function (k) { return byKey[k]; });
    }

    // ------------------------------------------------------------------
    // Horas por persona
    // ------------------------------------------------------------------
    /**
     * Intervalos de cada persona en una jornada.
     * @returns [{ userId, role: 'driver'|'companion', from, to }]
     */
    function participants(jornada, rec) {
        var out = [{ userId: jornada.driverId, role: 'driver', from: null, to: null }];
        ((rec && rec.members) || []).forEach(function (m) {
            if (!m.userId || m.userId === jornada.driverId) { return; }
            out.push({ userId: m.userId, role: 'companion', from: toMs(m.from), to: toMs(m.to) });
        });
        return out;
    }

    /** Intervalos de visita a clientes de la jornada (paradas con cliente cargado o zona de cliente). */
    function clientVisits(timeline, rec) {
        var out = [];
        (timeline.stops || []).forEach(function (s) {
            if (s.final || s.base) { return; }
            var e = stopEntry(rec, s.tripId);
            var clients = e && e.clients && e.clients.length ? e.clients : (s.zone ? [s.zone.name] : []);
            if (e && e.noClient) { clients = []; }
            if (!clients.length) { return; }
            out.push({
                tripId: s.tripId, from: s.from, to: s.to, clients: clients,
                zoneId: (e && e.zoneId) || (s.zone && s.zone.id) || null,
                confirmed: !!(e && e.clients && e.clients.length), point: s.point
            });
        });
        return out;
    }

    /**
     * Resumen por persona y día.
     * @param items [{ jornada, timeline, rec }]
     * @returns { "userId|AAAA-MM-DD": { userId, date, outside, driving, riding, client, jornadas:[keys], vehicles:[ids] } }
     *
     * Si una persona participa en varias jornadas del mismo día (cambió de vehículo) los
     * intervalos se unen, no se suman: nunca se cuentan dos veces las mismas horas.
     */
    function summarize(items) {
        var acc = {};
        (items || []).forEach(function (it) {
            var tl = it.timeline;
            if (!tl || tl.firstStart == null) { return; }
            var visits = clientVisits(tl, it.rec);
            participants(it.jornada, it.rec).forEach(function (p) {
                var k = p.userId + '|' + it.jornada.date;
                var a = acc[k] || (acc[k] = {
                    userId: p.userId, date: it.jornada.date,
                    _out: [], _drive: [], _ride: [], _client: [], jornadas: [], vehicles: []
                });
                var outside = clip(tl.outside, p.from, p.to);
                a._out = a._out.concat(outside);
                var mov = clip(tl.driving, p.from, p.to);
                if (p.role === 'driver') { a._drive = a._drive.concat(mov); }
                else { a._ride = a._ride.concat(mov); }
                a._client = a._client.concat(clip(visits, p.from, p.to));
                if (a.jornadas.indexOf(it.jornada.key) < 0) { a.jornadas.push(it.jornada.key); }
                if (a.vehicles.indexOf(it.jornada.deviceId) < 0) { a.vehicles.push(it.jornada.deviceId); }
            });
        });
        Object.keys(acc).forEach(function (k) {
            var a = acc[k];
            a.outside = total(a._out);
            a.driving = total(a._drive);
            a.riding = total(subtract(a._ride, a._drive));
            a.client = total(a._client);
            delete a._out; delete a._drive; delete a._ride; delete a._client;
        });
        return acc;
    }

    // ------------------------------------------------------------------
    // Almacenamiento (AddInData) — recibe funciones call/multiCall con Promise
    // ------------------------------------------------------------------
    function Store(call, multiCall) {
        this.call = call;
        this.multiCall = multiCall;
        this.whereOk = true;    // si el servidor rechaza whereClause, se cae al modo "traer todo"
    }

    Store.prototype.all = function () {
        return this.call('Get', { typeName: 'AddInData', search: { addInId: ADDIN_ID } }).then(function (list) {
            return (list || []).map(unwrap).filter(Boolean);
        });
    };

    Store.prototype.where = function (field, value) {
        return {
            typeName: 'AddInData',
            search: { addInId: ADDIN_ID, selectClause: 'rec', whereClause: field + ' = "' + String(value).replace(/"/g, '\\"') + '"' }
        };
    };

    /** Registros de tripulación de los días indicados. */
    Store.prototype.crewByDates = function (dates) {
        var self = this;
        var wanted = {};
        dates.forEach(function (d) { wanted[d] = true; });
        function viaAll() {
            return self.all().then(function (recs) {
                return dedupe(recs.filter(function (r) { return r.type === CREW && wanted[r.date]; }));
            });
        }
        if (!self.whereOk || !dates.length) { return dates.length ? viaAll() : Promise.resolve([]); }
        var calls = dates.map(function (d) { return ['Get', self.where('date', d)]; });
        return self.multiCall(calls).then(function (results) {
            var recs = [];
            (results || []).forEach(function (list) { (list || []).forEach(function (e) { recs.push(unwrap(e)); }); });
            recs = recs.filter(function (r) { return r && r.type === CREW && wanted[r.date]; });
            return dedupe(recs);
        }).catch(function () {
            self.whereOk = false;
            return viaAll();
        });
    };

    Store.prototype.byKey = function (key) {
        var self = this;
        var p = self.whereOk
            ? self.call('Get', self.where('key', key)).then(function (list) { return (list || []).map(unwrap); })
                .catch(function () { self.whereOk = false; return self.all(); })
            : self.all();
        return p.then(function (recs) {
            return dedupe((recs || []).filter(function (r) { return r && r.key === key; }))[0] || null;
        });
    };

    Store.prototype.settings = function () {
        return this.byKey(SETTINGS).then(function (rec) {
            var s = clone(DEFAULT_SETTINGS);
            if (rec) { Object.keys(s).forEach(function (k) { if (rec[k] != null) { s[k] = rec[k]; } }); s._id = rec._id; }
            return s;
        });
    };

    /**
     * Guarda un registro. Sin _id busca primero por clave (otro dispositivo o la oficina
     * pudo haberlo creado) y actualiza ese; si no existe lo crea. Devuelve el registro con _id.
     */
    Store.prototype.save = function (rec) {
        var self = this;
        fitSize(rec);
        var findId = rec._id ? Promise.resolve(rec._id) : self.byKey(rec.key).then(function (r) { return r ? r._id : null; });
        function add() {
            return self.call('Add', { typeName: 'AddInData', entity: { addInId: ADDIN_ID, details: wrap(strip(rec)) } });
        }
        return findId.then(function (id) {
            if (!id) { return add(); }
            var entity = { id: id, addInId: ADDIN_ID, details: wrap(strip(rec)) };
            return self.call('Set', { typeName: 'AddInData', entity: entity }).then(function () { return id; }, function (err) {
                // el registro pudo haberse borrado en el servidor: si ya no existe por clave, se recrea
                return self.byKey(rec.key).then(function (cur) {
                    if (cur && cur._id !== id) {
                        entity.id = cur._id;
                        return self.call('Set', { typeName: 'AddInData', entity: entity }).then(function () { return cur._id; });
                    }
                    if (cur) { throw err; }
                    return add();
                });
            });
        }).then(function (id) {
            var out = clone(strip(rec));
            out._id = id;
            return out;
        });
    };

    function settingsRecord(s, by) {
        var rec = { type: SETTINGS, key: SETTINGS, date: '', updatedAt: new Date().toISOString(), updatedBy: by || '' };
        Object.keys(DEFAULT_SETTINGS).forEach(function (k) { rec[k] = s[k] != null ? s[k] : DEFAULT_SETTINGS[k]; });
        if (s._id) { rec._id = s._id; }
        return rec;
    }

    // ------------------------------------------------------------------
    // CSV
    // ------------------------------------------------------------------
    function csv(rows) {
        return '﻿' + rows.map(function (r) {
            return r.map(function (v) {
                var s = String(v == null ? '' : v);
                return /[";\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
            }).join(';');
        }).join('\r\n');
    }

    return {
        ADDIN_ID: ADDIN_ID, VERSION: VERSION, CREW: CREW, SETTINGS: SETTINGS,
        UNKNOWN_DRIVER: UNKNOWN_DRIVER, DEFAULT_SETTINGS: DEFAULT_SETTINGS, MIN: MIN, DAY: DAY,
        esc: esc, clone: clone, toMs: toMs, iso: iso, parseTimeSpan: parseTimeSpan,
        dayKey: dayKey, dayStart: dayStart, dayEnd: dayEnd, daysBetween: daysBetween, addDays: addDays,
        hhmm: hhmm, fmtDuration: fmtDuration, hoursDecimal: hoursDecimal, idOf: idOf, userName: userName,
        expandGroups: expandGroups, userInGroups: userInGroups, isActive: isActive, operatorsFrom: operatorsFrom,
        buildJornadas: buildJornadas, inSegments: inSegments,
        compactZone: compactZone, pointInPolygon: pointInPolygon, zonesAt: zonesAt, classifyPoint: classifyPoint,
        union: union, clip: clip, subtract: subtract, total: total,
        buildTimeline: buildTimeline, stopsToAsk: stopsToAsk,
        newCrewRecord: newCrewRecord, addHistory: addHistory, activeMembers: activeMembers, hasCrew: hasCrew,
        stopEntry: stopEntry, wrap: wrap, unwrap: unwrap, strip: strip, fitSize: fitSize, dedupe: dedupe,
        participants: participants, clientVisits: clientVisits, summarize: summarize,
        Store: Store, settingsRecord: settingsRecord, csv: csv
    };
}));
