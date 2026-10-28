/* Tests de la lógica compartida. Ejecutar: TZ=America/Argentina/Buenos_Aires node --test tests/ */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const S = require('../scripts/shared.js');

const H = 3600000, M = 60000;
const NOW = new Date('2026-10-28T21:00:00Z').getTime();   // 18:00 en Argentina

// DriverChange reales de intcesetti (28/10/2026), recortados.
// b3: Canales (b7E) a la mañana, luego llave de mantenimiento (b41A, excluida), luego Andrés (b57).
// TripDriver b8 en el medio se asigna a Delboni.
const changes = [
    { type: 'DriverKey', dateTime: '2026-10-28T11:45:37.957Z', device: { id: 'b3' }, driver: { id: 'b7E' } },
    { type: 'TripDriver', dateTime: '2026-10-28T11:45:54.000Z', device: { id: 'b3' }, driver: { id: 'b7E' } },
    { type: 'DriverKey', dateTime: '2026-10-28T12:12:53.727Z', device: { id: 'b3' }, driver: 'UnknownDriverId' },
    { type: 'TripDriver', dateTime: '2026-10-28T16:18:35.493Z', device: { id: 'b3' }, driver: { id: 'b8' } },
    { type: 'DriverKey', dateTime: '2026-10-28T16:22:32.727Z', device: { id: 'b3' }, driver: { id: 'b41A' } },
    { type: 'DriverKey', dateTime: '2026-10-28T17:14:54.407Z', device: { id: 'b3' }, driver: { id: 'b57' } },
    { type: 'DriverKey', dateTime: '2026-10-28T17:35:50.730Z', device: { id: 'b3' }, driver: 'UnknownDriverId' },
    { type: 'DriverKey', dateTime: '2026-10-28T17:39:22.270Z', device: { id: 'b3' }, driver: { id: 'b57' } },
    // b4: Falcon (b43F) toda la mañana, con varios retiros de llave en el medio
    { type: 'DriverKey', dateTime: '2026-10-28T09:24:41.943Z', device: { id: 'b4' }, driver: { id: 'b43F' } },
    { type: 'DriverKey', dateTime: '2026-10-28T10:07:58.920Z', device: { id: 'b4' }, driver: 'UnknownDriverId' },
    { type: 'DriverKey', dateTime: '2026-10-28T10:08:28.733Z', device: { id: 'b4' }, driver: { id: 'b43F' } },
    { type: 'DriverKey', dateTime: '2026-10-28T13:11:23.910Z', device: { id: 'b4' }, driver: 'UnknownDriverId' },
    // día anterior en otro vehículo
    { type: 'DriverKey', dateTime: '2026-10-27T19:35:45.633Z', device: { id: 'bB' }, driver: { id: 'b43F' } }
];
const excluded = new Set(['b41A']);
const opts = { isExcluded: id => excluded.has(id), now: NOW };

test('parseTimeSpan', () => {
    assert.equal(S.parseTimeSpan('00:06:51'), (6 * 60 + 51) * 1000);
    assert.equal(S.parseTimeSpan('00:00:43.1130000'), 43113);
    assert.equal(S.parseTimeSpan('1.02:00:00'), 26 * H);
    assert.equal(S.parseTimeSpan(null), 0);
});

test('días locales en Argentina', () => {
    assert.equal(S.dayKey('2026-10-28T02:30:00Z'), '2026-10-27');   // 23:30 del 27
    assert.equal(S.dayKey('2026-10-28T03:30:00Z'), '2026-10-28');
    assert.deepEqual(S.daysBetween('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
    assert.equal(S.addDays('2026-10-01', -1), '2026-09-30');
});

test('jornadas: UnknownDriverId no corta; otra persona o llave excluida sí', () => {
    const js = S.buildJornadas(changes, opts);
    const keys = js.map(j => j.key);
    assert.deepEqual(keys.sort(), [
        '2026-10-27|bB|b43F', '2026-10-28|b3|b57', '2026-10-28|b3|b7E', '2026-10-28|b3|b8', '2026-10-28|b4|b43F'
    ].sort());
    const canales = js.find(j => j.key === '2026-10-28|b3|b7E');
    assert.equal(canales.segments.length, 1);
    assert.equal(canales.segments[0].to, Date.parse('2026-10-28T16:18:35.493Z'), 'corta cuando aparece otra persona');
    const delboni = js.find(j => j.key === '2026-10-28|b3|b8');
    assert.equal(delboni.segments[0].to, Date.parse('2026-10-28T16:22:32.727Z'), 'corta con la llave de mantenimiento');
    const falcon = js.find(j => j.key === '2026-10-28|b4|b43F');
    assert.equal(falcon.segments.length, 1, 'los retiros de llave no generan tramos nuevos');
    assert.equal(falcon.segments[0].to, NOW, 'el día de hoy termina en "now"');
    const andres = js.find(j => j.key === '2026-10-28|b3|b57');
    assert.equal(andres.firstAt, Date.parse('2026-10-28T17:14:54.407Z'));
    const ayer = js.find(j => j.key === '2026-10-27|bB|b43F');
    assert.equal(ayer.segments[0].to, S.dayEnd('2026-10-27'), 'un día pasado termina a la medianoche');
});

test('jornada con dos tramos si otra persona usó el vehículo en el medio', () => {
    const js = S.buildJornadas([
        { dateTime: '2026-10-20T11:00:00Z', device: { id: 'v' }, driver: { id: 'A' } },
        { dateTime: '2026-10-20T13:00:00Z', device: { id: 'v' }, driver: { id: 'B' } },
        { dateTime: '2026-10-20T15:00:00Z', device: { id: 'v' }, driver: { id: 'A' } }
    ], { now: NOW });
    const a = js.find(j => j.driverId === 'A');
    assert.equal(a.segments.length, 2);
    assert.ok(S.inSegments(Date.parse('2026-10-20T16:00:00Z'), a.segments));
    assert.ok(!S.inSegments(Date.parse('2026-10-20T14:00:00Z'), a.segments));
});

// Zonas: base cuadrada alrededor de (-68.05, -38.95) y un cliente alrededor de (-67.58, -39.04)
const sq = (id, name, x, y, d, types) => ({ id, name, zoneTypes: types || [], points: [
    { x: x - d, y: y - d }, { x: x + d, y: y - d }, { x: x + d, y: y + d }, { x: x - d, y: y + d }] });
const zones = [
    sq('zBase', 'Cesetti Base', -68.0578, -38.9504, 0.01),
    sq('zCli', 'Cliente Yacimiento', -67.5845, -39.0431, 0.01, [{ id: 'b6' }]),
    sq('zGrande', 'Área grande', -67.5845, -39.0431, 0.5, [{ id: 'b55' }])
].map(S.compactZone);
const settings = Object.assign({}, S.DEFAULT_SETTINGS, { baseZoneIds: ['zBase'], minStopMinutes: 10 });

test('zonas: punto en polígono y clasificación', () => {
    assert.equal(S.zonesAt({ x: -67.5845, y: -39.0431 }, zones)[0].id, 'zCli', 'la zona más chica primero');
    const c = S.classifyPoint({ x: -68.0578, y: -38.9504 }, zones, settings);
    assert.equal(c.base, true);
    assert.equal(S.classifyPoint({ x: -67.5845, y: -39.0431 }, zones, settings).zone.id, 'zCli');
    const soloB55 = Object.assign({}, settings, { clientZoneTypeIds: ['b55'] });
    assert.equal(S.classifyPoint({ x: -67.5845, y: -39.0431 }, zones, soloB55).zone.id, 'zGrande');
    assert.equal(S.classifyPoint({ x: 0, y: 0 }, zones, settings).zone, null);
});

// Jornada de Falcon en b4 (horarios de los Trip reales, simplificados)
const trips = [
    { id: 't1', device: { id: 'b4' }, start: '2026-10-28T09:31:34Z', stop: '2026-10-28T10:07:35Z',
        stopPoint: { x: -67.8239, y: -39.0124 }, nextTripStart: '2026-10-28T10:08:18Z', stopDuration: '00:00:43' },
    { id: 't2', device: { id: 'b4' }, start: '2026-10-28T10:08:18Z', stop: '2026-10-28T10:33:50Z',
        stopPoint: { x: -67.5845, y: -39.0431 }, nextTripStart: '2026-10-28T11:30:00Z', stopDuration: '00:56:10' },
    { id: 't3', device: { id: 'b4' }, start: '2026-10-28T11:30:00Z', stop: '2026-10-28T12:00:00Z',
        stopPoint: { x: -68.0578, y: -38.9504 }, nextTripStart: '2026-10-28T13:00:00Z', stopDuration: '01:00:00' },
    { id: 't4', device: { id: 'b4' }, start: '2026-10-28T13:00:00Z', stop: '2026-10-28T13:20:00Z',
        stopPoint: { x: -66.9, y: -39.1 }, nextTripStart: '2026-10-28T14:00:00Z', stopDuration: '00:40:00' },
    { id: 't5', device: { id: 'b4' }, start: '2026-10-28T14:00:00Z', stop: '2026-10-28T15:00:00Z',
        stopPoint: { x: -68.0578, y: -38.9504 }, stopDuration: '18:00:00' },
    { id: 'otro', device: { id: 'b7' }, start: '2026-10-28T10:00:00Z', stop: '2026-10-28T11:00:00Z' }
];

test('línea de tiempo: horas fuera descuentan paradas en la base', () => {
    const j = S.buildJornadas(changes, opts).find(x => x.key === '2026-10-28|b4|b43F');
    const tl = S.buildTimeline(j, trips, { zones, settings });
    assert.equal(tl.trips.length, 5, 'solo viajes del vehículo dentro de la jornada');
    assert.equal(tl.firstStart, Date.parse('2026-10-28T09:31:34Z'));
    assert.equal(tl.lastStop, Date.parse('2026-10-28T15:00:00Z'));
    // span 5:28:26, menos 1 h en base (12:00–13:00)
    assert.equal(S.total(tl.outside), 5 * H + 28 * M + 26000 - H);
    // paradas ≥ 10 min: t2 (cliente, 56 min), t3 (base), t4 (sin zona, 40 min), t5 (final)
    assert.deepEqual(tl.stops.map(s => s.tripId), ['t2', 't3', 't4', 't5']);
    assert.equal(tl.stops[0].zone.id, 'zCli');
    assert.equal(tl.stops[1].base, true);
    assert.equal(tl.stops[3].final, true);
    assert.deepEqual(S.stopsToAsk(tl).map(s => s.tripId), ['t2', 't4']);
});

test('horas por persona: chofer completo, acompañante desde que subió hasta que bajó', () => {
    const j = S.buildJornadas(changes, opts).find(x => x.key === '2026-10-28|b4|b43F');
    const tl = S.buildTimeline(j, trips, { zones, settings });
    const rec = S.newCrewRecord(j, { by: 'test' });
    rec.members = [
        { userId: 'b66', name: 'Vargas', from: '2026-10-28T09:00:00Z', to: null },
        { userId: 'b6E', name: 'Coñequeo', from: '2026-10-28T09:00:00Z', to: '2026-10-28T12:00:00Z' }
    ];
    rec.stops = [{ tripId: 't4', clients: ['Cliente sin geocerca'] }];
    const sum = S.summarize([{ jornada: j, timeline: tl, rec }]);
    const driver = sum['b43F|2026-10-28'];
    const vargas = sum['b66|2026-10-28'];
    const cone = sum['b6E|2026-10-28'];
    assert.equal(driver.outside, vargas.outside, 'el acompañante de toda la jornada suma lo mismo');
    assert.ok(driver.driving > 0 && vargas.driving === 0 && vargas.riding === driver.driving);
    // Coñequeo bajó a las 12:00 → 09:31:34–12:00 = 2:28:26
    assert.equal(cone.outside, 2 * H + 28 * M + 26000);
    // clientes: t2 (56:10, zona) + t4 (40 min, cargado) para el chofer; solo t2 para Coñequeo
    assert.equal(driver.client, 56 * M + 10000 + 40 * M);
    assert.equal(cone.client, 56 * M + 10000);
});

test('una persona en dos vehículos el mismo día no suma horas dos veces', () => {
    const j1 = { key: 'd|v1|A', date: '2026-10-20', deviceId: 'v1', driverId: 'A', segments: [{ from: 0, to: 1e15 }] };
    const j2 = { key: 'd|v2|B', date: '2026-10-20', deviceId: 'v2', driverId: 'B', segments: [{ from: 0, to: 1e15 }] };
    const tl = (a, b) => ({ firstStart: a, lastStop: b, outside: [{ from: a, to: b }], driving: [{ from: a, to: b }], stops: [] });
    const rec2 = { members: [{ userId: 'A', from: null, to: null }] };
    const sum = S.summarize([
        { jornada: j1, timeline: tl(10 * H, 14 * H), rec: null },
        { jornada: j2, timeline: tl(12 * H, 16 * H), rec: rec2 }
    ]);
    assert.equal(sum['A|2026-10-20'].outside, 6 * H, '10–16 h, no 8 h');
    assert.equal(sum['A|2026-10-20'].riding, 2 * H, 'acompañando solo 14–16 h (10–14 manejaba)');
});

test('operarios: grupos incluidos/excluidos con subgrupos y bajas', () => {
    const groups = [
        { id: 'b2792', name: 'Conductores', children: [{ id: 'b2B6F' }, { id: 'b2B70' }] },
        { id: 'b2B6F', children: [] }, { id: 'b2B70', children: [] }, { id: 'b28E3', children: [] }
    ];
    const users = [
        { id: 'b43F', firstName: 'Mauricio', lastName: 'Falcon', driverGroups: [{ id: 'b2B6F' }], isDriver: true },
        { id: 'b41A', firstName: 'Llave', lastName: 'mant.', driverGroups: [{ id: 'b28E3' }], isDriver: true },
        { id: 'b7B', firstName: 'Agustin', lastName: 'Jara', driverGroups: [{ id: 'b2B6F' }], isDriver: true, activeTo: '2026-02-11T13:12:37Z' },
        { id: 'b4', firstName: 'Baltasar', lastName: 'Cesetti', driverGroups: [{ id: 'GroupCompanyId' }], isDriver: true }
    ];
    const s = Object.assign({}, S.DEFAULT_SETTINGS, { operatorGroupIds: ['b2792'], excludeGroupIds: ['b28E3'] });
    assert.deepEqual(S.operatorsFrom(users, groups, s, NOW).map(o => o.id), ['b43F']);
    const sinFiltro = Object.assign({}, S.DEFAULT_SETTINGS, { excludeGroupIds: ['b28E3'] });
    assert.deepEqual(S.operatorsFrom(users, groups, sinFiltro, NOW).map(o => o.id).sort(), ['b4', 'b43F']);
});

test('AddInData: wrap/unwrap con y sin selectClause, dedupe y límite de tamaño', () => {
    const rec = S.newCrewRecord({ key: 'k', date: '2026-10-28', deviceId: 'b4', driverId: 'b43F', firstAt: NOW }, { by: 'x' });
    const full = S.unwrap({ id: 'a1', details: S.wrap(rec) });
    const sel = S.unwrap({ id: 'a1', details: rec });
    assert.equal(full.key, 'k'); assert.equal(sel.key, 'k'); assert.equal(sel._id, 'a1');
    assert.equal(S.unwrap({ id: 'z', details: 'basura' }), null);
    const older = Object.assign({}, rec, { updatedAt: '2026-01-01' });
    assert.equal(S.dedupe([older, rec])[0].updatedAt, rec.updatedAt);
    for (let i = 0; i < 25; i++) { S.addHistory(rec, 'u', 'edit', 'x'.repeat(400)); }
    assert.ok(S.fitSize(rec) <= 9500);
    assert.equal(S.strip(Object.assign({ _id: 'a', _dirty: true }, rec))._id, undefined);
});

test('Store: whereClause por fecha y caída a "traer todo" si el servidor lo rechaza', async () => {
    const rec = S.newCrewRecord({ key: '2026-10-28|b4|b43F', date: '2026-10-28', deviceId: 'b4', driverId: 'b43F', firstAt: NOW }, {});
    const db = [{ id: 'a1', details: S.wrap(rec) }];
    let rejectWhere = false, sets = 0, adds = 0;
    const call = async (method, p) => {
        if (method === 'Get') {
            if (p.search.whereClause) {
                if (rejectWhere) { throw new Error('ArgumentException'); }
                const m = /^(\w+) = "(.*)"$/.exec(p.search.whereClause);
                return db.filter(e => e.details[m[1]] === m[2]).map(e => ({ id: e.id, details: e.details.rec }));
            }
            return db;
        }
        if (method === 'Set') { sets++; return; }
        if (method === 'Add') { adds++; return 'aNew'; }
    };
    const multiCall = calls => Promise.all(calls.map(c => call(c[0], c[1])));
    const st = new S.Store(call, multiCall);
    assert.equal((await st.crewByDates(['2026-10-28', '2026-10-27'])).length, 1);
    const saved = await st.save(S.clone(rec));                       // sin _id → encuentra por clave → Set
    assert.equal(saved._id, 'a1'); assert.equal(sets, 1);
    const nuevo = await st.save(Object.assign(S.clone(rec), { key: 'otra' }));
    assert.equal(nuevo._id, 'aNew'); assert.equal(adds, 1);
    rejectWhere = true;
    assert.equal((await st.crewByDates(['2026-10-28'])).length, 1, 'fallback');
    assert.equal(st.whereOk, false);
    const s = await st.settings();
    assert.equal(s.minStopMinutes, 10);
});

test('Store: si el registro se borró en el servidor, save lo recrea en vez de quedar trabado', async () => {
    const rec = S.newCrewRecord({ key: 'k1', date: '2026-10-28', deviceId: 'b4', driverId: 'b43F', firstAt: NOW }, {});
    rec._id = 'aBorrado';
    const db = [];
    const call = async (method, p) => {
        if (method === 'Get') { return db.filter(e => !p.search.whereClause || p.search.whereClause === 'key = "' + e.details.key + '"').map(e => ({ id: e.id, details: e.details.rec })); }
        if (method === 'Set') { if (!db.some(e => e.id === p.entity.id)) { throw new Error('InvalidEntity'); } return; }
        if (method === 'Add') { db.push({ id: 'aNuevo', details: p.entity.details }); return 'aNuevo'; }
    };
    const st = new S.Store(call, calls => Promise.all(calls.map(c => call(c[0], c[1]))));
    const saved = await st.save(rec);
    assert.equal(saved._id, 'aNuevo');
    assert.equal(db.length, 1);
});

// ---------------- Movimientos dentro del predio y viajes desde/hacia el domicilio ----------------
// Oficina real de intcesetti: "Buenos Aires 444, Neuquén" (b339B)
const OFICINA = { id: 'b339B', name: 'Buenos Aires 444, Neuquén, Argentina', zoneTypes: ['ZoneTypeVendorServiceCenterId'], points: [
    { x: -68.05851745605469, y: -38.94969940185547 }, { x: -68.05671691894531, y: -38.94969940185547 },
    { x: -68.05671691894531, y: -38.95090103149414 }, { x: -68.05851745605469, y: -38.95090103149414 }] };
const zonas2 = [S.compactZone(OFICINA), S.compactZone(sq('zYac', 'Yacimiento Loma Campana', -68.6, -38.3, 0.03, [{ id: 'b6' }]))];
const conf2 = Object.assign({}, S.DEFAULT_SETTINGS, { baseZoneIds: ['b339B'], minStopMinutes: 10 });
const CASA = { x: -68.10, y: -38.96 };
const T = (h, m) => Date.UTC(2026, 9, 20, h + 3, m);  // hora local de Argentina (UTC-3)
const trip = (id, h1, m1, h2, m2, pt, km) => ({ id, device: { id: 'v' }, start: new Date(T(h1, m1)).toISOString(),
    stop: new Date(T(h2, m2)).toISOString(), stopPoint: pt, distance: km });
const jornadaV = { key: '2026-10-20|v|A', date: '2026-10-20', deviceId: 'v', driverId: 'A', segments: [{ from: T(6, 0), to: T(23, 0) }] };

test('movimientos cortos dentro del predio del cliente se fusionan en una sola visita', () => {
    const pozo1 = { x: -66.90, y: -39.10 }, pozo2 = { x: -66.903, y: -39.101 }, pozo3 = { x: -66.905, y: -39.102 };
    const trips = [
        trip('a', 7, 30, 8, 0, { x: -68.0578, y: -38.9504 }, 3),       // de casa a la oficina
        trip('b', 8, 30, 9, 30, pozo1, 60),                            // a la locación
        trip('c', 10, 0, 10, 4, pozo2, 0.4),                           // 400 m, 4 min → mismo predio
        trip('d', 10, 30, 10, 33, pozo3, 0.3),                         // 300 m, 3 min → mismo predio
        trip('e', 12, 0, 13, 0, { x: -68.0578, y: -38.9504 }, 60),     // vuelve a la oficina
        trip('f', 18, 0, 18, 20, CASA, 5)                              // a casa
    ];
    const tl = S.buildTimeline(jornadaV, trips, { zones: zonas2, settings: conf2 });
    const visita = tl.stops.filter(s => !s.base && !s.final);
    assert.equal(visita.length, 1, 'una sola visita en vez de tres paradas');
    assert.deepEqual(visita[0].tripIds, ['b', 'c', 'd']);
    assert.equal(visita[0].moves, 2);
    assert.equal(visita[0].from, T(9, 30));
    assert.equal(visita[0].to, T(12, 0), 'desde que llegó hasta que se fue del predio');
    // movimiento largo: no se fusiona
    const largo = trips.map(t => t.id === 'c' ? Object.assign({}, t, { distance: 4 }) : t);
    assert.equal(S.buildTimeline(jornadaV, largo, { zones: zonas2, settings: conf2 }).stops.filter(s => !s.base && !s.final).length, 2);
    // dentro de la misma geocerca se fusiona aunque el movimiento sea largo
    const enYac = [trip('y1', 8, 0, 9, 0, { x: -68.62, y: -38.31 }, 50), trip('y2', 10, 0, 10, 25, { x: -68.58, y: -38.29 }, 3.5),
        trip('y3', 12, 0, 13, 0, { x: -68.0578, y: -38.9504 }, 50)];
    const tlY = S.buildTimeline(jornadaV, enYac, { zones: zonas2, settings: conf2 });
    assert.equal(tlY.stops.filter(s => !s.base && !s.final).length, 1);
    assert.equal(tlY.stops[0].zone.name, 'Yacimiento Loma Campana');
});

test('viajes desde y hacia el domicilio: no cuentan por defecto, configurable', () => {
    const ayer = { id: 'z', device: { id: 'v' }, start: new Date(T(-6, 0)).toISOString(), stop: new Date(T(-5, 40)).toISOString(), stopPoint: CASA };
    const trips = [ayer,
        trip('a', 7, 30, 8, 0, { x: -66.9, y: -39.1 }, 40),            // de casa directo al cliente
        trip('b', 12, 0, 13, 0, { x: -68.0578, y: -38.9504 }, 40),     // a la oficina
        trip('c', 17, 0, 17, 20, CASA, 5)];                            // de la oficina a casa
    const tl = S.buildTimeline(jornadaV, trips, { zones: zonas2, settings: conf2 });
    assert.equal(tl.firstStart, T(8, 0), 'empieza al llegar al primer destino');
    assert.equal(tl.lastStop, T(17, 0), 'termina al salir de la última parada de trabajo');
    assert.deepEqual(tl.commuteIn, { from: T(7, 30), to: T(8, 0) });
    assert.deepEqual(tl.commuteOut, { from: T(17, 0), to: T(17, 20) });
    // 08:00–17:00 menos la oficina 13:00–17:00 = 5 h
    assert.equal(S.total(tl.outside), 5 * H);
    assert.equal(S.total(tl.driving), H, 'el manejo a/desde casa tampoco cuenta (solo 12:00–13:00)');
    const incl = S.buildTimeline(jornadaV, trips, { zones: zonas2, settings: Object.assign({}, conf2, { commute: 'include' }) });
    assert.equal(incl.firstStart, T(7, 30));
    assert.equal(incl.lastStop, T(17, 20));
    // si el vehículo durmió en la oficina, el primer viaje cuenta
    const desdeOficina = [Object.assign({}, ayer, { stopPoint: { x: -68.0578, y: -38.9504 } })].concat(trips.slice(1));
    assert.equal(S.buildTimeline(jornadaV, desdeOficina, { zones: zonas2, settings: conf2 }).firstStart, T(7, 30));
    // sin datos del día anterior no se sabe de dónde salió: cuenta
    assert.equal(S.buildTimeline(jornadaV, trips.slice(1), { zones: zonas2, settings: conf2 }).firstStart, T(7, 30));
});

test('los acompañantes que el chofer deja en su casa no suman el viaje de vuelta', () => {
    const trips = [trip('a', 8, 0, 9, 0, { x: -66.9, y: -39.1 }, 40), trip('b', 15, 0, 16, 0, CASA, 45)];
    const tl = S.buildTimeline(jornadaV, trips, { zones: zonas2, settings: conf2 });
    const sum = S.summarize([{ jornada: jornadaV, timeline: tl, rec: { members: [{ userId: 'B', from: null, to: null }] } }]);
    assert.equal(sum['B|2026-10-20'].outside, 7 * H, '08:00–15:00, sin el viaje a casa');
});
