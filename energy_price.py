"""Download dei prezzi del mercato del giorno prima da Energy-Charts.

Energy-Charts (Fraunhofer ISE, https://api.energy-charts.info) pubblica i
prezzi del mercato elettrico del giorno prima per zona, senza registrazione.
Si usa l'API versione 2 (/v2/price).

Cosa fa questo modulo:
  1. chiede a Energy-Charts i prezzi della zona per gli ultimi giorni fino
     alla data scelta, con una sola chiamata;
  2. prende i valori della data scelta: sono ogni 15 minuti, quindi li
     raggruppa per ora e ne fa la media (24 valori);
  3. converte da €/MWh a €/kWh (diviso 1000), l'unità usata dal DSS;
  4. se la data scelta non ha ancora prezzi (quelli di domani escono verso le
     13 di oggi), usa come stima i prezzi dell'ultimo giorno disponibile,
     dichiarandolo nel risultato.

Attenzione: sono prezzi all'ingrosso di una zona (non il PUN) e non
comprendono oneri di rete e imposte. Il valore in euro è quindi più basso di
una bolletta, ma è la forma della curva (ore care e ore economiche) a guidare
l'ottimizzazione.

Formato della risposta (estratto):
  {"unit": "EUR / MWh",
   "data": [{"timestamp": "2026-11-06T00:00:00+01:00",
             "values": {"day_ahead_price": 250}}, ...]}
Gli orari sono già nell'ora locale della zona (per l'Italia, ora italiana).
"""
import json
import urllib.error
import urllib.parse
import urllib.request
from datetime import date, datetime, timedelta

URL_API = "https://api.energy-charts.info/v2/price"
SERIE_PREZZO = "day_ahead_price"
TIMEOUT_S = 20

# Quanti giorni indietro cercare un giorno completo da usare come stima
GIORNI_STIMA = 7

# Zone geografiche italiane (codice Energy-Charts -> nome)
ZONE = {
    "IT-North": "Nord",
    "IT-Centre-North": "Centro-Nord",
    "IT-Centre-South": "Centro-Sud",
    "IT-South": "Sud",
    "IT-Calabria": "Calabria",
    "IT-Sicily": "Sicilia",
    "IT-Sardinia": "Sardegna",
}
ZONA_PREDEFINITA = "IT-South"  # Lecce (Puglia) è nella zona Sud


class ErrorePrezzi(Exception):
    """Errore con un messaggio già comprensibile per l'utente."""


def scarica(giorno, zona):
    """Chiama Energy-Charts per gli ultimi GIORNI_STIMA giorni fino a `giorno`.

    Restituisce la risposta JSON, oppure None se non ci sono dati (404).
    """
    parametri = urllib.parse.urlencode({
        "bzn": zona,
        "start": (giorno - timedelta(days=GIORNI_STIMA)).isoformat(),
        "end": giorno.isoformat(),
    })
    richiesta = urllib.request.Request(
        f"{URL_API}?{parametri}",
        headers={"User-Agent": "DSS-FlowShop/1.0", "Accept": "application/json"},
    )
    try:
        with urllib.request.urlopen(richiesta, timeout=TIMEOUT_S) as risposta:
            return json.loads(risposta.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        if exc.code == 404:
            return None
        dettaglio = exc.read().decode("utf-8", errors="replace")[:300]
        raise ErrorePrezzi(f"Energy-Charts ha risposto con errore {exc.code}: {dettaglio}") from exc
    except (urllib.error.URLError, TimeoutError, OSError) as exc:
        raise ErrorePrezzi(
            "Impossibile contattare Energy-Charts (connessione assente o "
            "servizio non raggiungibile). I prezzi attuali restano invariati."
        ) from exc


def prezzi_per_giorno_e_ora(dati):
    """Raggruppa i prezzi (€/MWh) per giorno e ora: {data: {ora: [valori]}}."""
    gruppi = {}
    for punto in (dati or {}).get("data", []):
        prezzo = (punto.get("values") or {}).get(SERIE_PREZZO)
        if prezzo is None:  # valore non (ancora) disponibile
            continue
        istante = datetime.fromisoformat(punto["timestamp"])
        gruppi.setdefault(istante.date(), {}).setdefault(istante.hour, []).append(prezzo)
    return gruppi


def media_oraria(ore):
    """24 prezzi orari in €/kWh da {ora: [valori €/MWh]}, o None se mancano
    più ore. Un'ora mancante (il giorno del passaggio all'ora legale non
    esistono le 2:00) si riempie con la media delle ore vicine."""
    medie = [sum(ore[h]) / len(ore[h]) if ore.get(h) else None for h in range(24)]
    mancanti = [h for h in range(24) if medie[h] is None]
    if len(mancanti) > 1:
        return None
    for h in mancanti:
        vicini = [medie[k] for k in (h - 1, h + 1) if 0 <= k < 24 and medie[k] is not None]
        medie[h] = sum(vicini) / len(vicini)
    return [round(m / 1000, 5) for m in medie]  # €/MWh -> €/kWh


def prezzi_del_giorno(data_iso, zona=ZONA_PREDEFINITA):
    """Data (AAAA-MM-GG) e zona -> 24 prezzi orari in €/kWh, pronti per la
    dashboard. Se la data non ha ancora prezzi, usa quelli dell'ultimo giorno
    completo e lo segnala con "stima": True e "data_prezzi"."""
    if zona not in ZONE:
        raise ErrorePrezzi(f"Zona non disponibile: {zona}.")
    try:
        giorno = date.fromisoformat(data_iso)
    except (TypeError, ValueError) as exc:
        raise ErrorePrezzi("Data non valida.") from exc

    gruppi = prezzi_per_giorno_e_ora(scarica(giorno, zona))

    # Il giorno scelto o, in mancanza, il più recente giorno completo precedente
    for indietro in range(GIORNI_STIMA + 1):
        giorno_prezzi = giorno - timedelta(days=indietro)
        prezzi = media_oraria(gruppi.get(giorno_prezzi, {}))
        if prezzi is not None:
            break
    else:
        raise ErrorePrezzi(
            f"Nessun prezzo disponibile per la zona {ZONE[zona]} nei "
            f"{GIORNI_STIMA} giorni fino al {giorno:%d/%m/%Y}."
        )

    return {
        "prezzi_ipex_24h": prezzi,
        "fonte": "Energy-Charts (Fraunhofer ISE), mercato del giorno prima",
        "zona": zona,
        "zona_nome": ZONE[zona],
        "data": giorno.isoformat(),
        "data_prezzi": giorno_prezzi.isoformat(),
        "stima": giorno_prezzi != giorno,
        "valori_ricevuti": sum(len(v) for v in gruppi[giorno_prezzi].values()),
        "min_kwh": min(prezzi),
        "max_kwh": max(prezzi),
    }
