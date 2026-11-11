"""Empezar de cero (v1.4): el panel borra los registros, conserva la configuración y los teléfonos
descartan lo que tenían sin sincronizar de antes del borrado."""
import pathlib, sys, datetime
from playwright.sync_api import sync_playwright

AR = datetime.timezone(datetime.timedelta(hours=-3))
FIXED_NOW = datetime.datetime.now(AR).replace(hour=11, minute=0, second=0, microsecond=0)
REPO = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).parent
OUT = HERE / 'shots'; OUT.mkdir(exist_ok=True)
errors = []
def check(c, m):
    print(('OK   ' if c else 'FAIL ') + m)
    if not c: errors.append(m)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 1280, 'height': 900}, timezone_id='America/Argentina/Buenos_Aires', locale='es-AR')
    # 1) teléfono de Falcon: carga tripulación SIN señal (queda pendiente en el teléfono)
    phone = ctx.new_page()
    phone.on('pageerror', lambda e: errors.append('pageerror: %s' % e))
    phone.clock.set_fixed_time(FIXED_NOW)
    phone.add_init_script(path=str(HERE / 'mockapi.js'))
    phone.goto((REPO / 'workingHoursDrive.html').as_uri())
    phone.evaluate("""() => new Promise(res => { const o = geotab.addin.workingHoursDrive(); window.__addin = o;
        o.initialize(window.__api, window.__state, () => { o.focus(window.__api, window.__state); res(); }); })""")
    phone.wait_for_selector('[data-act=crew]')
    phone.evaluate("window.__state.online = false")
    phone.click('[data-act=crew]')
    phone.check('[data-pick=b66]')
    phone.click('[data-act=saveCrew]')
    phone.wait_for_timeout(300)
    check(phone.evaluate("Object.values(JSON.parse(localStorage.getItem('wh.v1.records'))).some(r => r._dirty)"), 'tripulación pendiente en el teléfono')
    # y otra ya sincronizada en el servidor (de otro chofer)
    phone.evaluate("""() => { const S = WorkingHoursShared; const c = S.newCrewRecord({ key: 'x|b7E', date: S.dayKey(Date.now()), deviceId: 'b3', driverId: 'b7E', firstAt: Date.now() }, {});
        window.__db.AddInData.push({ id: 'aX', addInId: S.ADDIN_ID, details: S.wrap(c) });
        const st = S.settingsRecord(Object.assign({}, S.DEFAULT_SETTINGS, { baseZoneIds: ['zBase'] }), 'admin');
        window.__db.AddInData.push({ id: 'aS', addInId: S.ADDIN_ID, details: S.wrap(st) }); }""")
    server = phone.evaluate('JSON.stringify(window.__db.AddInData)')

    # 2) panel: borrar todo (con la misma base)
    pan = ctx.new_page()
    pan.on('pageerror', lambda e: errors.append('pageerror: %s' % e))
    pan.clock.set_fixed_time(FIXED_NOW + datetime.timedelta(minutes=5))
    pan.add_init_script(path=str(HERE / 'mockapi.js'))
    pan.goto((REPO / 'workingHours.html').as_uri())
    pan.evaluate("(s) => { window.__db.AddInData = JSON.parse(s); window.__userName = 'supervisor@cesetti.com.ar'; }", server)
    pan.evaluate("""() => new Promise(res => { const a = geotab.addin.workingHours(); a.initialize(window.__api, {}, () => { a.focus(window.__api, {}); res(); }); })""")
    pan.wait_for_selector('#wh-hours tr')
    pan.click('.wh-tab[data-tab=settings]')
    pan.wait_for_selector('#wh-s-reset')
    check(pan.is_disabled('#wh-s-reset'), 'el botón está bloqueado hasta escribir BORRAR')
    pan.fill('#wh-s-reset-txt', 'borrar')
    check(pan.is_enabled('#wh-s-reset'), 'se habilita al escribir BORRAR')
    pan.screenshot(path=str(OUT / 'reset_1_panel.png'), full_page=True)
    pan.click('#wh-s-reset')
    pan.wait_for_timeout(600)
    left = pan.evaluate('window.__db.AddInData.map(e => e.details.type)')
    check(left == ['settings'], 'queda solo la configuración (%s)' % left)
    st = pan.evaluate("window.__db.AddInData[0].details.rec")
    check(st.get('dataEpoch') and st.get('sinceDate') and st.get('baseZoneIds') == ['zBase'], 'configuración conservada, con fecha de inicio')
    check('se borraron 1 registros' in pan.inner_text('#wh-msg'), 'informa cuántos borró')
    after = pan.evaluate('JSON.stringify(window.__db.AddInData)')

    # 3) el teléfono vuelve a tener señal: no re-sube la tripulación vieja
    phone.clock.set_fixed_time(FIXED_NOW + datetime.timedelta(minutes=10))
    phone.evaluate("(s) => { window.__db.AddInData = JSON.parse(s); window.__state.online = true; window.__addin.focus(window.__api, window.__state); }", after)
    phone.wait_for_timeout(800)
    types = phone.evaluate('window.__db.AddInData.map(e => e.details.type)')
    check(types == ['settings'], 'el teléfono descartó lo pendiente anterior al borrado (%s)' % types)
    check('Falta cargar acompañantes' in phone.inner_text('.whd-card'), 'la jornada de hoy sigue, sin tripulación')
    # lo nuevo sí se guarda
    phone.click('[data-act=crew]')
    phone.check('[data-pick=b66]')
    phone.click('[data-act=saveCrew]')
    phone.wait_for_timeout(400)
    check(phone.evaluate('window.__db.AddInData.filter(e => e.details.type === "crew").length') == 1, 'lo cargado después del borrado se sincroniza')
    b.close()

if errors:
    print('\n'.join(errors)); sys.exit(1)
print('TODO OK')
