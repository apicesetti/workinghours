// API simulado de MyGeotab/Drive con datos con la forma de intcesetti (fechas relativas a hoy).
(function () {
    'use strict';
    window.geotab = { addin: {} };
    var pad = function (n) { return (n < 10 ? '0' : '') + n; };
    var now = new Date();
    var at = function (h, m, dayOffset) {
        var d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (dayOffset || 0), h, m, 0, 0);
        return d.toISOString();
    };
    var sq = function (id, name, x, y, d, types) {
        return { id: id, name: name, zoneTypes: types || [], activeTo: '2050-01-01T00:00:00Z',
            points: [{ x: x - d, y: y - d }, { x: x + d, y: y - d }, { x: x + d, y: y + d }, { x: x - d, y: y + d }] };
    };
    var db = {
        User: [
            { id: 'b43F', name: 'mf@cesetti.com.ar', firstName: 'Mauricio', lastName: 'Falcon', isDriver: true, driverGroups: [{ id: 'b2B6F' }], employeeNo: '' },
            { id: 'b66', name: 'cv@cesetti.com.ar', firstName: 'Cristian', lastName: 'Vargas', isDriver: true, driverGroups: [{ id: 'b2B6F' }], employeeNo: '38063773' },
            { id: 'b6E', name: 'bnc@cesetti.com.ar', firstName: 'Braian', lastName: 'Coñequeo', isDriver: true, driverGroups: [{ id: 'b2B6F' }], employeeNo: '45390447' },
            { id: 'b57', name: 'ka@cesetti.com.ar', firstName: 'Kevin', lastName: 'Andrés', isDriver: true, driverGroups: [{ id: 'b2B6F' }], employeeNo: '40612799' },
            { id: 'b7E', name: 'mc@cesetti.com.ar', firstName: 'Mariano', lastName: 'Canales', isDriver: true, driverGroups: [{ id: 'b2B6F' }] },
            { id: 'b41A', name: 'Llave_de_mantenimiento_AR', firstName: 'Llave de mantenimiento AR', lastName: '.', isDriver: true, driverGroups: [{ id: 'b28E3' }] },
            { id: 'b7B', name: 'aj@cesetti.com.ar', firstName: 'Agustin', lastName: 'Jara', isDriver: true, driverGroups: [{ id: 'b2B6F' }], activeTo: '2026-02-11T13:12:37Z' }
        ],
        Group: [
            { id: 'GroupCompanyId', name: 'Company Group', children: [{ id: 'b278D' }, { id: 'b284F' }] },
            { id: 'b278D', name: 'Supervisión', children: [{ id: 'b2792' }, { id: 'b28E3' }] },
            { id: 'b2792', name: 'Conductores', children: [{ id: 'b2B6F' }, { id: 'b2B70' }] },
            { id: 'b2B6F', name: 'Tecnicos de campo', children: [] },
            { id: 'b2B70', name: 'Otros', children: [] },
            { id: 'b28E3', name: 'Llaves de mantenimiento', children: [] },
            { id: 'b284F', name: 'Llaves sin asignar', children: [] }
        ],
        Device: [
            { id: 'b4', name: 'OE', licensePlate: 'AD229OE' },
            { id: 'b3', name: 'WP', licensePlate: 'AD866WP' }
        ],
        Zone: [
            sq('zBase', 'Cesetti - Base Neuquén', -68.0578, -38.9504, 0.01, [{ id: 'b6' }]),
            sq('zCli', 'Cesetti - Batería 8 Tecpetrol-FDP', -67.5845, -39.0431, 0.01, [{ id: 'b6' }]),
            sq('zNip', 'Cesetti - Nippon', -67.0, -39.2, 0.01, [{ id: 'b55' }])
        ],
        ZoneType: [{ id: 'b6', name: 'Locaciones' }, { id: 'b55', name: 'Clientes' }],
        DriverChange: [
            { type: 'DriverKey', dateTime: at(8, 24), device: { id: 'b4' }, driver: { id: 'b43F' } },
            { type: 'TripDriver', dateTime: at(8, 31), device: { id: 'b4' }, driver: { id: 'b43F' } },
            { type: 'DriverKey', dateTime: at(10, 7), device: { id: 'b4' }, driver: 'UnknownDriverId' },
            { type: 'DriverKey', dateTime: at(10, 8), device: { id: 'b4' }, driver: { id: 'b43F' } },
            { type: 'DriverKey', dateTime: at(12, 11), device: { id: 'b4' }, driver: 'UnknownDriverId' },
            { type: 'DriverKey', dateTime: at(8, 45), device: { id: 'b3' }, driver: { id: 'b7E' } },
            { type: 'DriverKey', dateTime: at(11, 22), device: { id: 'b3' }, driver: { id: 'b41A' } },
            { type: 'DriverKey', dateTime: at(12, 14), device: { id: 'b3' }, driver: { id: 'b57' } }
        ],
        Trip: [
            { id: 't1', device: { id: 'b4' }, driver: { id: 'b43F' }, start: at(8, 31), stop: at(9, 7), stopPoint: { x: -67.8239, y: -39.0124 }, nextTripStart: at(9, 8), stopDuration: '00:01:00', drivingDuration: '00:36:00' },
            { id: 't2', device: { id: 'b4' }, driver: { id: 'b43F' }, start: at(9, 8), stop: at(9, 33), stopPoint: { x: -67.5845, y: -39.0431 }, nextTripStart: at(10, 30), stopDuration: '00:57:00', drivingDuration: '00:25:00' },
            { id: 't3', device: { id: 'b4' }, driver: { id: 'b43F' }, start: at(10, 30), stop: at(11, 0), stopPoint: { x: -66.5, y: -39.5 }, nextTripStart: at(11, 40), stopDuration: '00:40:00', drivingDuration: '00:30:00' },
            { id: 't4', device: { id: 'b4' }, driver: { id: 'b43F' }, start: at(11, 40), stop: at(12, 10), stopPoint: { x: -68.0578, y: -38.9504 }, stopDuration: '04:00:00', drivingDuration: '00:30:00' },
            { id: 't5', device: { id: 'b3' }, driver: { id: 'b7E' }, start: at(8, 50), stop: at(9, 30), stopPoint: { x: -67.0, y: -39.2 }, nextTripStart: at(10, 30), stopDuration: '01:00:00', drivingDuration: '00:40:00' },
            { id: 't6', device: { id: 'b3' }, driver: { id: 'b7E' }, start: at(10, 30), stop: at(11, 10), stopPoint: { x: -68.0578, y: -38.9504 }, nextTripStart: at(12, 20), stopDuration: '01:10:00', drivingDuration: '00:40:00' },
            { id: 't7', device: { id: 'b3' }, driver: { id: 'b57' }, start: at(12, 20), stop: at(13, 0), stopPoint: { x: -67.5845, y: -39.0431 }, stopDuration: '03:00:00', drivingDuration: '00:40:00' }
        ],
        AddInData: []
    };
    window.__db = db;
    window.__calls = [];
    window.__notifications = [];
    window.__failNext = 0;
    var seq = 1;

    function inRange(t, s) {
        var ms = new Date(t).getTime();
        return (!s.fromDate || ms >= new Date(s.fromDate).getTime()) && (!s.toDate || ms <= new Date(s.toDate).getTime());
    }
    function get(p) {
        var s = p.search || {};
        var list = (db[p.typeName] || []).slice();
        if (p.typeName === 'AddInData') {
            list = list.filter(function (e) { return e.addInId === s.addInId; });
            if (s.whereClause) {
                var m = /^(\w+) = "(.*)"$/.exec(s.whereClause);
                if (!m) { throw { name: 'ArgumentException', message: 'bad where' }; }
                list = list.filter(function (e) { return e.details[m[1]] === m[2]; });
            }
            return list.map(function (e) {
                return { id: e.id, addInId: e.addInId, details: s.selectClause ? JSON.parse(JSON.stringify(e.details[s.selectClause])) : JSON.parse(JSON.stringify(e.details)) };
            });
        }
        if (s.id) { list = list.filter(function (e) { return e.id === s.id; }); }
        if (s.name) { list = list.filter(function (e) { return e.name === s.name; }); }
        if (s.isDriver) { list = list.filter(function (e) { return e.isDriver; }); }
        if (s.userSearch) { list = list.filter(function (e) { return e.driver && e.driver.id === s.userSearch.id; }); }
        if (s.deviceSearch) { list = list.filter(function (e) { return e.device && e.device.id === s.deviceSearch.id; }); }
        if (p.typeName === 'DriverChange') { list = list.filter(function (e) { return inRange(e.dateTime, s); }); }
        if (p.typeName === 'Trip') { list = list.filter(function (e) { return inRange(e.start, s); }); }
        return JSON.parse(JSON.stringify(list));
    }
    function exec(method, p) {
        window.__calls.push([method, p.typeName, JSON.parse(JSON.stringify(p))]);
        if (method === 'Get') { return get(p); }
        if (method === 'Add' && p.typeName === 'AddInData') {
            var e = JSON.parse(JSON.stringify(p.entity)); e.id = 'aD' + (seq++); db.AddInData.push(e); return e.id;
        }
        if (method === 'Set' && p.typeName === 'AddInData') {
            var cur = db.AddInData.filter(function (x) { return x.id === p.entity.id; })[0];
            if (!cur) { throw { name: 'InvalidEntity', message: 'no existe ' + p.entity.id }; }
            cur.details = JSON.parse(JSON.stringify(p.entity.details)); return null;
        }
        throw { name: 'MethodNotSupported', message: method + ' ' + p.typeName };
    }
    window.__state = { online: true, device: 'b4', driving: false };
    window.__api = {
        call: function (method, params, ok, err) {
            setTimeout(function () {
                if (!window.__state.online || window.__failNext > 0) { window.__failNext--; err({ name: 'NetworkError', message: 'sin red' }); return; }
                try { ok(exec(method, params)); } catch (e) { err(e); }
            }, 5);
        },
        multiCall: function (calls, ok, err) {
            setTimeout(function () {
                if (!window.__state.online) { err({ name: 'NetworkError', message: 'sin red' }); return; }
                try { ok(calls.map(function (c) { return exec(c[0], c[1]); })); } catch (e) { err(e); }
            }, 5);
        },
        getSession: function (cb, newSession) {
            if (typeof newSession === 'function') { throw new Error('MethodNotSupported: 2.º parámetro debe ser booleano'); }
            setTimeout(function () { cb({ userName: window.__userName || 'mf@cesetti.com.ar', database: 'intcesetti' }); }, 5);
        },
        mobile: {
            exists: function () { return true; },
            notification: { notify: function (message, title) { window.__notifications.push({ title: title, message: message }); return Promise.resolve(); } },
            listenTo: function (cb) { window.__listener = cb; }
        }
    };
}());
