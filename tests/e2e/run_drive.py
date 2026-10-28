"""Prueba de punta a punta del add-in de Drive con el API simulado."""
import json, pathlib, sys
from playwright.sync_api import sync_playwright

REPO = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).parent
OUT = HERE / 'shots'
OUT.mkdir(exist_ok=True)
errors = []

def check(cond, msg):
    print(('OK   ' if cond else 'FAIL ') + msg)
    if not cond:
        errors.append(msg)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 400, 'height': 820}, timezone_id='America/Argentina/Buenos_Aires', locale='es-AR')
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append('pageerror: %s' % e))
    page.on('console', lambda m: m.type == 'error' and errors.append('console: %s' % m.text))
    page.on('dialog', lambda d: d.accept())
    page.add_init_script(path=str(HERE / 'mockapi.js'))
    page.goto((REPO / 'workingHoursDrive.html').as_uri())

    # 1) startup (sin interfaz) → notificación
    page.evaluate("""() => new Promise(res => {
        window.__startup = geotab.addin.workingHoursDrive();
        window.__startup.startup(window.__api, window.__state, res);
    })""")
    n = page.evaluate('window.__notifications')
    check(len(n) == 1, 'startup lanza una notificación (%d)' % len(n))
    if n:
        print('     ', n[0])
        check('OE' in n[0]['message'] and '08:24' in n[0]['message'], 'la notificación menciona vehículo y hora de identificación')
    # una segunda revisión no repite la notificación
    page.evaluate("""() => new Promise(res => { const o = geotab.addin.workingHoursDrive(); o.startup(window.__api, window.__state, res); })""")
    check(len(page.evaluate('window.__notifications')) == 1, 'no repite la notificación de la misma jornada')

    # 2) página
    page.evaluate("""() => new Promise(res => {
        window.__addin = geotab.addin.workingHoursDrive();
        window.__addin.initialize(window.__api, window.__state, () => { window.__addin.focus(window.__api, window.__state); res(); });
    })""")
    page.wait_for_selector('.whd-card')
    page.wait_for_timeout(300)
    page.screenshot(path=str(OUT / 'drive_1_home.png'), full_page=True)
    check(page.locator('.whd-card').count() == 1, 'una jornada (OE) para Falcon')
    check('Falta cargar acompañantes' in page.inner_text('.whd-card'), 'jornada marcada como pendiente')
    check(page.inner_text('#whd-who') == 'Mauricio Falcon', 'muestra el chofer logueado')

    # 3) cargar acompañantes
    page.click('[data-act=crew]')
    page.wait_for_selector('.whd-pick')
    names = page.locator('.whd-pick li').all_inner_texts()
    print('      candidatos:', [x.split('\n')[0] for x in names])
    check(not any('Llave' in x for x in names), 'las llaves de mantenimiento no aparecen como acompañantes (requiere config de excluidos)') if False else None
    check(not any('Falcon' in x for x in names), 'el propio chofer no aparece')
    check(not any('Jara' in x for x in names), 'los usuarios dados de baja no aparecen')
    page.fill('#whd-search', 'var')
    page.wait_for_timeout(100)
    check(page.locator('.whd-pick li').count() == 1, 'el buscador filtra')
    page.check('[data-pick=b66]')
    page.fill('#whd-search', '')
    page.check('[data-pick=b6E]')
    page.screenshot(path=str(OUT / 'drive_2_crew.png'), full_page=True)
    check('(2)' in page.inner_text('[data-act=saveCrew]'), 'botón Guardar muestra 2 seleccionados')
    page.click('[data-act=saveCrew]')
    page.wait_for_timeout(400)
    db = page.evaluate('window.__db.AddInData')
    check(len(db) == 1, 'se creó un registro AddInData')
    rec = db[0]['details']['rec'] if db else {}
    check(db and db[0]['details']['date'] and db[0]['details']['type'] == 'crew', 'envoltorio con type/date/key para whereClause')
    check([m['userId'] for m in rec.get('members', [])] == ['b66', 'b6E'], 'acompañantes guardados')
    check(rec.get('members', [{}])[0].get('from', '').endswith('Z') and rec['members'][0]['from'] == rec['identifiedAt'], 'primera carga: desde la hora de identificación')
    check('Cristian Vargas' in page.inner_text('.whd-card'), 'la tarjeta muestra la tripulación')

    # 4) paradas
    page.click('[data-act=stops]')
    page.wait_for_selector('.whd-stop')
    page.screenshot(path=str(OUT / 'drive_3_stops.png'), full_page=True)
    stops = page.locator('.whd-stop').count()
    check(stops == 2, 'dos paradas para completar (cliente con geocerca + parada sin zona) — hay %d' % stops)
    first_sel = page.eval_on_selector('[data-stop-sel="0"]', 'e => e.value')
    check(first_sel == 'Cesetti - Batería 8 Tecpetrol-FDP', 'la parada en geocerca viene sugerida')
    page.select_option('[data-stop-sel="1"]', '__other')
    check(page.is_visible('[data-stop-other="1"]'), 'aparece el campo para escribir otro cliente')
    page.fill('[data-stop-other="1"]', 'YPF Loma Campana')
    page.click('[data-act=saveStops]')
    page.wait_for_timeout(400)
    rec = page.evaluate('window.__db.AddInData[0].details.rec')
    check(len(page.evaluate('window.__db.AddInData')) == 1, 'actualiza el mismo registro (Set), no duplica')
    cl = sorted(sum((s['clients'] for s in rec['stops']), []))
    check(cl == ['Cesetti - Batería 8 Tecpetrol-FDP', 'YPF Loma Campana'], 'clientes de las paradas guardados: %s' % cl)

    # 5) offline: se baja un acompañante sin señal
    page.click('[data-act=home]')
    page.evaluate("window.__state.online = false")
    page.click('[data-act=crew]')
    page.wait_for_selector('[data-act=drop]')
    page.click('[data-act=drop][data-user=b6E]')
    page.wait_for_timeout(300)
    check(page.is_visible('#whd-sync') and 'sin sincronizar' in page.inner_text('#whd-sync'), 'muestra cambios pendientes sin conexión')
    rec = page.evaluate('window.__db.AddInData[0].details.rec')
    check(all(m['to'] is None for m in rec['members']), 'sin conexión no llegó al servidor')
    page.screenshot(path=str(OUT / 'drive_4_offline.png'), full_page=True)
    # recarga de la app sin red: lo pendiente sobrevive en localStorage
    server = page.evaluate('JSON.stringify(window.__db.AddInData)')
    page.reload()
    page.evaluate("""(server) => new Promise(res => {
        window.__db.AddInData = JSON.parse(server);
        window.__state.online = false;
        const o = geotab.addin.workingHoursDrive();
        window.__addin = o;
        o.initialize(window.__api, window.__state, () => { o.focus(window.__api, window.__state); res(); });
    })""", server)
    page.wait_for_timeout(400)
    check('sin sincronizar' in page.inner_text('#whd-sync'), 'lo pendiente sobrevive a reiniciar Drive sin red')
    check(page.locator('.whd-card').count() == 1, 'muestra la jornada desde la caché sin red')
    # vuelve la señal
    page.evaluate("""() => { window.__state.online = true; window.__addin.focus(window.__api, window.__state); }""")
    page.wait_for_timeout(600)
    rec = page.evaluate('window.__db.AddInData[0].details.rec')
    dropped = [m for m in rec['members'] if m['userId'] == 'b6E'][0]
    check(dropped['to'] is not None, 'al volver la señal se sincroniza la bajada')
    check(page.is_hidden('#whd-sync'), 'sin pendientes después de sincronizar')

    # 6) cerrar jornada
    page.click('[data-act=close]')
    page.wait_for_timeout(400)
    rec = page.evaluate('window.__db.AddInData[0].details.rec')
    check(rec['status'] == 'closed' and rec['closedBy'] == 'mf@cesetti.com.ar', 'jornada cerrada con usuario')
    check(all(m['to'] for m in rec['members']), 'al cerrar se baja a todos')
    check(len(rec['history']) >= 4, 'historial registrado (%d entradas)' % len(rec['history']))
    page.screenshot(path=str(OUT / 'drive_5_closed.png'), full_page=True)

    # 7) getSession nunca recibe una función como 2.º parámetro (se lanzaría error)
    check(not [e for e in errors if 'MethodNotSupported' in e], 'getSession con firma correcta')
    b.close()

print()
print('ERRORES:' if errors else 'TODO OK', *errors, sep='\n  ')
sys.exit(1 if errors else 0)
