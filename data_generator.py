"""Generazione dei dati: storico di produzione simulato e ordini del giorno.

Lo storico simula le lavorazioni passate: per ogni record prodotto, macchina,
velocità, quantità, durata, potenza assorbita e tempo di setup. Durata e
potenza seguono formule fisiche semplici più un rumore casuale. È il dataset
su cui si allenano i modelli XGBoost.

Calcola inoltre, per i prodotti del giorno, i valori della baseline (velocità
media storica) e i tempi di setup medi usati dallo scheduler.
"""
import numpy as np
import pandas as pd
from config import MACCHINE, N_MACCHINE, load_config, log_debug
from scipy import stats


class DataGenerator:
    """Genera storico e ordini a partire dai parametri di config.json."""

    def __init__(self, tot_prodotti=None, seed=None):
        """seed: intero per rendere riproducibili storico e ordini (None = casuale)."""
        self.tot_prodotti = tot_prodotti or [
            f"P_{i}" for i in range(1, 51)
        ]
        self.seed = seed
        self.rng = np.random.default_rng(seed)
        # Generatore separato per i fattori di consumo: con lo stesso seed,
        # storico, ordini e velocità non cambiano se cambiano questi parametri
        self.rng_consumi = np.random.default_rng(None if seed is None else [seed, 1])
        self.vel_nominali = None  # matrice (n_prodotti x n_macchine)
        self.fattori_potenza = None  # matrice (n_prodotti x n_macchine)

        cfg = load_config()
        self.cfg_hist = cfg["dataset_storico"]
        self.cfg_ordini = cfg.get(
            "ordini_giornalieri",
            {
                "n_ordini": 5,
                "quantita_m2": {"min": 500.0, "max": 2000.0},
            },
        )

    def _genera_velocita_nominali(self):
        """Assegna a ogni coppia (prodotto, macchina) una velocità tipica.

        È pescata una sola volta per coppia, in una fascia centrale
        dell'intervallo [min, max], così la dispersione attorno a essa non
        viene tagliata dai limiti. La velocità media storica di ogni coppia
        (la baseline) risulta quindi diversa da prodotto a prodotto e da
        macchina a macchina.
        """
        v_cfg = self.cfg_hist["velocita_m2h"]
        frac = self.cfg_hist.get(
            "velocita_nominale_frac", {"min": 0.35, "max": 0.7}
        )
        span = v_cfg["max"] - v_cfg["min"]
        u = self.rng.uniform(
            frac["min"], frac["max"], size=(len(self.tot_prodotti), N_MACCHINE)
        )
        self.vel_nominali = v_cfg["min"] + u * span
        return self.vel_nominali

    def _genera_fattori_potenza(self):
        """Consumo specifico di ogni coppia (prodotto, macchina).

        A parità di velocità, la potenza assorbita dipende da:
          - il prodotto (il materiale: da 0,80 a 1,25, come il massello
            rispetto al compensato);
          - la macchina (motori e meccanica diversi: fattore_macchina in
            config.json, predefinito da 0,80 a 1,30);
          - la coppia, con una piccola variazione propria (variazione_coppia,
            predefinita 10%): lo stesso materiale non "pesa" allo stesso modo
            su tutte le macchine.
        Il fattore finale è il prodotto dei tre, fissato una volta per seed.
        """
        p_cfg = self.cfg_hist["potenza_kw"]
        f_mac = p_cfg.get("fattore_macchina", {"min": 0.8, "max": 1.3})
        sigma_coppia = p_cfg.get("variazione_coppia", 0.10)
        rng = self.rng_consumi

        p_num = np.array([int(p.split("_")[1]) for p in self.tot_prodotti])
        fattore_prodotto = 0.8 + (p_num % 10) * 0.05
        fattore_macchina = rng.uniform(f_mac["min"], f_mac["max"], size=N_MACCHINE)
        fattore_coppia = rng.lognormal(
            mean=-0.5 * sigma_coppia ** 2, sigma=sigma_coppia,
            size=(len(self.tot_prodotti), N_MACCHINE),
        )
        self.fattori_potenza = (
            fattore_prodotto[:, None] * fattore_macchina[None, :] * fattore_coppia
        )
        return self.fattori_potenza

    def genera_storico_globale(self, n_samples=None):
        """Genera lo storico simulato (un DataFrame, una riga per lavorazione).

        Formule usate:
          - durata = quantità / velocità, con un rumore lognormale piccolo;
          - potenza = base + coeff × (velocità / divisore)^esponente,
            moltiplicata per il consumo specifico della coppia prodotto/macchina
            (vedi _genera_fattori_potenza) e per un rumore normale;
          - setup = valore uniforme tra min e max, con rumore lognormale.
        """
        n_samples = n_samples or self.cfg_hist["n_samples"]

        q_cfg = self.cfg_hist["quantita_m2"]
        v_cfg = self.cfg_hist["velocita_m2h"]
        s_cfg = self.cfg_hist["tempo_setup_min"]
        p_cfg = self.cfg_hist["potenza_kw"]
        noise_cfg = self.cfg_hist["rumore"]
        disp_v = self.cfg_hist.get("dispersione_velocita", 0.35)

        log_debug("=== CONFIGURAZIONE E IMPOSTAZIONI INIZIALI ===")
        log_debug(f"Seed: {self.seed if self.seed is not None else 'casuale'}")
        log_debug(f"Macchine usate ({N_MACCHINE}): {MACCHINE}")
        log_debug(f"Numero prodotti totali a catalogo: {len(self.tot_prodotti)}")
        log_debug(f"Numerosità storico da generare: {n_samples} record")
        log_debug("Soglie Generazione Storico:")
        log_debug(
            f"  - Quantità (m²): min={q_cfg['min']}, max={q_cfg['max']}"
        )
        log_debug(
            f"  - Velocità (m²/h): min={v_cfg['min']}, max={v_cfg['max']}"
            f" (dispersione ±{disp_v * 100:.0f}% attorno alla velocità tipica"
            " di ogni coppia prodotto/macchina)"
        )
        log_debug(
            f"  - Tempo Setup (minuti): min={s_cfg['min']}, max={s_cfg['max']}"
        )
        log_debug("==============================================")

        rng = self.rng
        v_nom_mat = self._genera_velocita_nominali()
        fattori_potenza = self._genera_fattori_potenza()

        # Prodotto e macchina di ogni record, estratti tutti insieme (numpy)
        p_idx = rng.integers(0, len(self.tot_prodotti), size=n_samples)
        m_idx = rng.integers(0, N_MACCHINE, size=n_samples)

        # Velocità: attorno al valore tipico della coppia, entro i limiti
        v_nom = v_nom_mat[p_idx, m_idx]
        v = v_nom * rng.uniform(1.0 - disp_v, 1.0 + disp_v, size=n_samples)
        v = np.clip(v, v_cfg["min"], v_cfg["max"])

        q = rng.uniform(q_cfg["min"], q_cfg["max"], size=n_samples)

        # Durata: q / v con rumore lognormale. Il parametro mean = -sigma²/2
        # fa sì che il rumore valga 1 in media (nessuno spostamento sistematico)
        mean_corr = -0.5 * (noise_cfg["sigma_tempo"] ** 2)
        t_reale = (q / v) * rng.lognormal(
            mean=mean_corr, sigma=noise_cfg["sigma_tempo"], size=n_samples
        )

        potenza_base = p_cfg["base"] + p_cfg["coeff_velocita"] * (
            (v / p_cfg["divisore_velocita"]) ** p_cfg["esponente_velocita"]
        )
        p_reale = (potenza_base * fattori_potenza[p_idx, m_idx]) * rng.normal(
            loc=1.0, scale=noise_cfg["sigma_potenza"], size=n_samples
        )

        t_setup_min = rng.uniform(s_cfg["min"], s_cfg["max"], size=n_samples)
        t_setup_reale = (t_setup_min / 60.0) * rng.lognormal(
            mean=0.0, sigma=noise_cfg["sigma_setup"], size=n_samples
        )

        return pd.DataFrame({
            "ID_Prodotto": np.array(self.tot_prodotti)[p_idx],
            "ID_Macchina": np.array(MACCHINE)[m_idx],
            "Velocita": v,
            "Quantita_m2": q,
            "Tempo_h": t_reale,
            "Potenza_kW": p_reale,
            "Tempo_Setup_h": t_setup_reale,
        })

    def estrai_ordini_giornalieri(self, df_hist_global, n_ordini=None):
        """Estrae a caso gli ordini del giorno (prodotto e quantità in m²).

        I prodotti vengono scelti solo tra quelli presenti nello storico,
        altrimenti i modelli non avrebbero dati su cui basare le previsioni.
        """
        n_ord = n_ordini or self.cfg_ordini["n_ordini"]
        q_min = self.cfg_ordini["quantita_m2"]["min"]
        q_max = self.cfg_ordini["quantita_m2"]["max"]

        prodotti_disponibili = df_hist_global["ID_Prodotto"].unique().tolist()

        if not prodotti_disponibili:
            raise ValueError(
                "Lo storico fornito è vuoto: impossibile estrarre gli ordini."
            )

        n_da_estrarre = min(n_ord, len(prodotti_disponibili))

        prods_24h = [
            str(p)
            for p in self.rng.choice(
                prodotti_disponibili, size=n_da_estrarre, replace=False
            )
        ]

        ordini_24h = []
        for p in prods_24h:
            quantita = round(float(self.rng.uniform(q_min, q_max)), 2)
            ordini_24h.append({"ID_Prodotto": p, "Quantita_m2": quantita})

        log_debug(
            f"Estratti {len(ordini_24h)} ordini giornalieri da un totale di"
            f" {len(prodotti_disponibili)} prodotti presenti nello storico"
            f" (Range m²: {q_min}-{q_max})"
        )

        return prods_24h, ordini_24h

    def calcola_tempi_setup_trimmed(
        self, df_hist_global, prodotti_giornalieri, proportiontocut=0.05
    ):
        """Tempo di setup tipico per ogni coppia (prodotto, macchina), in ore.

        Usa la media troncata: scarta il 5% dei valori più bassi e il 5% dei
        più alti prima di fare la media, così pochi valori anomali non la
        falsano.
        """
        log_debug("Calcolo della media troncata (5%) per i tempi di setup...")
        df_filtered = df_hist_global[
            df_hist_global["ID_Prodotto"].isin(prodotti_giornalieri)
        ]

        setup_dict = {}
        grouped = df_filtered.groupby(["ID_Prodotto", "ID_Macchina"])[
            "Tempo_Setup_h"
        ]

        for (p_id, m_id), series in grouped:
            mean_val = stats.trim_mean(
                series.values, proportiontocut=proportiontocut
            )
            setup_dict[(p_id, m_id)] = float(mean_val)

        return setup_dict

    def calcola_velocita_baseline_prodotto(
        self, df_hist_global, prodotti_giornalieri
    ):
        """Velocità della baseline: media storica per coppia (prodotto, macchina).

        È la velocità a cui si lavorerebbe "come al solito", senza
        ottimizzazione: serve da termine di confronto per NSGA-II.
        """
        log_debug(
            "Calcolo velocità di baseline specifiche per prodotto/macchina dallo"
            " storico..."
        )
        df_filtered = df_hist_global[
            df_hist_global["ID_Prodotto"].isin(prodotti_giornalieri)
        ]

        vel_baseline_dict = {}
        grouped = df_filtered.groupby(["ID_Prodotto", "ID_Macchina"])[
            "Velocita"
        ]

        for (p_id, m_id), series in grouped:
            vel_baseline_dict[(p_id, m_id)] = float(series.mean())

        return vel_baseline_dict

    def calcola_potenza_ferma(self, df_hist_global, frazione):
        """Potenza assorbita da ogni macchina quando è accesa ma non lavora
        (setup, pause, attese), in kW: una frazione della sua potenza media in
        lavorazione nello storico.

        Gli studi sulle macchine utensili indicano che una macchina ferma ma
        accesa assorbe una parte rilevante della potenza (circa un terzo):
        ignorarla renderebbe "gratis" le pause e le attese.
        """
        medie = df_hist_global.groupby("ID_Macchina")["Potenza_kW"].mean()
        potenza_ferma = {m: float(frazione * medie.get(m, 0.0)) for m in MACCHINE}
        log_debug(
            f"Potenza a macchina ferma ({frazione:.0%} della media in lavorazione): "
            + ", ".join(f"{m} {p:.1f} kW" for m, p in potenza_ferma.items())
        )
        return potenza_ferma
