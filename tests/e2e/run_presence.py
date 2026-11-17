"""Presencia (v1.6): el teléfono comparado con el vehículo confirma, baja y suma acompañantes solo."""
import pathlib, sys, datetime
from playwright.sync_api import sync_playwright

AR = datetime.timezone(datetime.timedelta(hours=-3))
T0 = datetime.datetime.now(AR).replace(hour=11, minute=0, second=0, microsecond=0)
REPO = pathlib.Path(__file__).resolve().parents[2]
HERE = pathlib.Path(__file__).parent
OUT = HERE / 'shots'; OUT.mkdir(exist_ok=True)
errors = []
def check(c, m):
    print(('OK   ' if c else 'FAIL ') + m)
    if not c: errors.append(m)

P = {'lat': -39.0, 'lon': -68.0}   # posición del vehículo OE (b4) de Falcon

def as_user(page, login):
    page.evaluate("""(login) => new Promise(res => {
        localStorage.clear(); window.__userName = login; window.__notifications.length = 0;
        const o = geotab.addin.workingHoursDrive(); window.__addin = o;
        o.initialize(window.__api, window.__state, () => { o.focus(window.__api, window.__state); res(); });
    })""", login)
    page.wait_for_timeout(600)

def tick(page, minutes=0):
    global now
    now = now + datetime.timedelta(minutes=minutes)
    page.clock.set_fixed_time(now)
    page.evaluate("() => window.__addin._presence()")
    page.wait_for_timeout(400)

def recs(page, typ):
    return [e['details']['rec'] for e in page.evaluate('window.__db.AddInData') if e['details']['type'] == typ]

def utc(t):
    return t.astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')

def dsi(page, lat, lon, driving=True, minutes_ahead=0):
    # dateTime = el momento de la próxima lectura (tick avanza el reloj antes de leer)
    page.evaluate("([a, b, d, t]) => { window.__dsi = [{ device: { id: 'b4' }, driver: { id: 'b43F' }, latitude: a, longitude: b, isDriving: d, dateTime: t }]; }",
                  [lat, lon, driving, utc(now + datetime.timedelta(minutes=minutes_ahead))])

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={'width': 400, 'height': 860}, timezone_id='America/Argentina/Buenos_Aires', locale='es-AR')
    page = ctx.new_page()
    page.on('pageerror', lambda e: errors.append('pageerror: %s' % e))
    page.on('console', lambda m: m.type == 'error' and errors.append('console: %s' % m.text))
    now = T0
    page.clock.set_fixed_time(now)
    page.add_init_script(path=str(HERE / 'mockapi.js'))
    page.goto((REPO / 'workingHoursDrive.html').as_uri())
    dsi(page, P['lat'], P['lon'])

    # 1) Falcon carga a Vargas en OE
    as_user(page, 'mf@cesetti.com.ar')
    page.click('[data-act=crew]'); page.check('[data-pick=b66]'); page.click('[data-act=saveCrew]'); page.wait_for_timeout(400)

    # 2) Vargas va con el vehículo en marcha: se confirma solo
    as_user(page, 'cv@cesetti.com.ar')
    check(page.is_visible('.whd-card-ask'), 'Vargas tiene la pregunta "¿Viajás con…?"')
    page.evaluate("(p) => { window.__phone = { lat: p.lat + 0.0005, lon: p.lon, acc: 10 }; window.__notifications.length = 0; }", P)
    tick(page)
    acks = recs(page, 'ack')
    check(len(acks) == 1 and acks[0]['status'] == 'ok' and acks[0].get('auto'), 'confirmación automática por posición')
    check(not page.is_visible('.whd-card-ask'), 'ya no tiene que tocar nada')
    pres = [r for r in recs(page, 'presence') if r['userId'] == 'b66']
    check(len(pres) == 1 and pres[0]['segs'][0][0] == 'b4' and pres[0]['segs'][0][3] == 'n', 'presencia guardada (solo cerca/lejos, sin recorrido)')
    check('lat' not in str(pres[0]), 'la presencia no guarda coordenadas')

    # 3) Vargas se queda en un pozo y el vehículo sigue: se baja solo (2 lecturas lejos)
    page.evaluate("(p) => { window.__phone = { lat: p.lat + 0.02, lon: p.lon, acc: 10 }; window.__notifications.length = 0; }", P)
    tick(page, 3); tick(page, 3)
    leaves = recs(page, 'leave')
    check(len(leaves) == 1 and leaves[0].get('auto') and leaves[0]['userId'] == 'b66', 'bajada automática registrada')
    n = page.evaluate('window.__notifications')
    check(any(x['title'] == 'Te bajaste de OE · AD229OE' for x in n), 'se le avisa (%s)' % [x['title'] for x in n])
    check(page.is_visible('text=Registrado automáticamente') and page.is_visible('[data-act=undoAuto]'), 'puede deshacerlo')
    page.screenshot(path=str(OUT / 'presence_1_bajada.png'), full_page=True)
    rides = page.inner_text('.whd-idcard')
    check('Mis viajes de acompañante' in rides and 'con Mauricio Falcon' in rides and '– 11:03' in rides, 've su viaje de acompañante con la bajada (%s)' % rides.replace(chr(10), ' | ')[:160])
    page.click('[data-act=undoAuto]'); page.wait_for_timeout(400)
    check(recs(page, 'leave')[0]['undone'] is True, 'deshecho')
    check(page.is_visible('[data-act=leave]') and 'confirmado por tu teléfono' in page.inner_text('.whd-idcard'), 'vuelve a estar a bordo, confirmado por su teléfono, con "Me bajé"')
    page.screenshot(path=str(OUT / 'presence_1b_acompanante.png'), full_page=True)
    page.click('[data-act=leave]'); page.wait_for_timeout(400)
    lv = [r for r in recs(page, 'leave') if not r.get('auto')]
    check(len(lv) == 1, '"Me bajé" a mano')

    # 4) Coñequeo (sin tripulación) viaja con el vehículo en marcha: se suma solo
    as_user(page, 'bnc@cesetti.com.ar')
    for k in range(4):
        lat = P['lat'] + 0.01 * k
        dsi(page, lat, P['lon'], minutes_ahead=2)
        page.evaluate("(a) => { window.__phone = { lat: a + 0.0004, lon: %s, acc: 10 }; }" % P['lon'], lat)
        tick(page, 2)
    cl = recs(page, 'claim')
    check(len(cl) == 1 and cl[0].get('auto') and cl[0]['status'] == 'accepted' and cl[0]['driverId'] == 'b43F' and cl[0]['deviceId'] == 'b4', 'detectado y sumado como acompañante de Falcon')
    n = page.evaluate('window.__notifications')
    check(any(x['title'] == 'Viajás con Mauricio Falcon' for x in n), 'se le avisa')

    # 4b) Andrés en ciudad: 7 km/h y la posición del vehículo llega 1 km atrasada; el recorrido (LogRecord) sí lo muestra
    as_user(page, 'ka@cesetti.com.ar')
    base = P['lat'] + 0.2
    for k in range(4):
        lat = base + 0.0022 * k          # ~245 m cada 2 min ≈ 7 km/h
        dsi(page, lat - 0.009, P['lon'], minutes_ahead=-1)  # posición "actual" atrasada ~1 km y de hace 3 min
        page.evaluate("([a, lon, iso]) => { window.__logs = [{ device: { id: 'b4' }, dateTime: iso, latitude: a, longitude: lon }]; window.__phone = { lat: a + 0.0003, lon: lon, acc: 12 }; }",
                      [lat, P['lon'], (now + datetime.timedelta(minutes=2)).astimezone(datetime.timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.000Z')])
        tick(page, 2)
    cl = [r for r in recs(page, 'claim') if r['userId'] == 'b57']
    check(len(cl) == 1 and cl[0].get('auto') and cl[0]['deviceId'] == 'b4', 'detectado en ciudad (lento) con la posición del vehículo atrasada')
    check('Posición del teléfono' in page.inner_text('#whDrive'), 'muestra la última lectura de posición (%s)' % [l for l in page.inner_text('#whDrive').split(chr(10)) if 'Posición' in l])
    page.evaluate("() => { window.__logs = []; }")

    # 4c) falso positivo (caso real 17/11): Jara quieto en la base, el GPS salta adentro del edificio,
    #     y el vehículo de Falcon entra a la base y estaciona
    as_user(page, 'mc@cesetti.com.ar')
    base = (P['lat'] + 0.5, P['lon'])
    approach = [0.012, 0.006, 0.002, 0.0, 0.0, 0.0]   # km→ grados al norte de la base
    for k, off in enumerate(approach):
        vlat = base[0] + off
        dsi(page, vlat, base[1], driving=off > 0 or k == 3, minutes_ahead=2)
        page.evaluate("([a, lon, iso]) => { window.__logs = [{ device: { id: 'b4' }, dateTime: iso, latitude: a, longitude: lon }]; }",
                      [vlat, base[1], utc(now + datetime.timedelta(minutes=2))])
        j = 0.0016 if k % 2 else -0.0016           # salta ±180 m
        page.evaluate("([a, lon]) => { window.__phone = { lat: a, lon: lon, acc: 35 }; }", [base[0] + j, base[1]])
        tick(page, 2)
    check(not [r for r in recs(page, 'claim') if r['userId'] == 'b7E'], 'quieto en la base: NO se lo suma aunque el vehículo entre y el GPS salte')
    page.evaluate("() => { window.__logs = []; }")

    # 5) Falcon lo ve en su tripulación, marcado como automático
    as_user(page, 'mf@cesetti.com.ar')
    n = page.evaluate('window.__notifications')
    check(any(x['title'] == 'Braian Coñequeo viaja con vos' for x in n) and any(x['title'] == 'Kevin Andrés viaja con vos' for x in n), 'Falcon recibe los avisos')
    card = page.inner_text('.whd-idcard')
    check('Braian Coñequeo · automático' in card and 'Cristian Vargas' in card, 'tripulación con lo automático (%s)' % card.replace(chr(10), ' | ')[:200])
    page.screenshot(path=str(OUT / 'presence_2_chofer.png'), full_page=True)
    saved = page.evaluate('JSON.stringify(window.__db.AddInData)')

    # 6) panel de MyGeotab: corroboración por posición
    pan = ctx.new_page()
    pan.on('pageerror', lambda e: errors.append('pageerror: %s' % e))
    pan.clock.set_fixed_time(now)
    pan.add_init_script(path=str(HERE / 'mockapi.js'))
    pan.set_viewport_size({'width': 1280, 'height': 900})
    pan.goto((REPO / 'workingHours.html').as_uri())
    pan.evaluate("(s) => { window.__db.AddInData = JSON.parse(s); window.__userName = 'supervisor@cesetti.com.ar'; }", saved)
    pan.evaluate("""() => new Promise(res => { const a = geotab.addin.workingHours(); a.initialize(window.__api, {}, () => { a.focus(window.__api, {}); res(); }); })""")
    pan.wait_for_selector('#wh-hours tr')
    pan.click('.wh-tab[data-tab=jornadas]')
    pan.wait_for_timeout(300)
    txt = pan.inner_text('#wh-jornadas')
    print('      ', [l for l in txt.split(chr(10)) if 'Coñequeo' in l or 'Vargas' in l][:3])
    check('Braian Coñequeo' in txt and 'detectado por posición' in txt and '✓ con el vehículo' in txt, 'el panel muestra lo detectado y la corroboración')
    pan.screenshot(path=str(OUT / 'presence_3_panel.png'), full_page=True)
    b.close()

if errors:
    print('\n'.join(errors)); sys.exit(1)
print('TODO OK')

