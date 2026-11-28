// SONDE MÉMOIRE DU JEU WEB (20/11/2026).
//
// Pourquoi : un joueur (Firefox, partie solo contre quatre IA, pendant un vote) a vu le jeu s'arrêter sur
// abort("OOM") — le tas WebAssembly a voulu dépasser son plafond. Rejouée ailleurs, la même situation laisse le tas
// plat (~290 Mo) : la cause est un pic qu'on ne sait pas reproduire. Cette sonde le photographie la prochaine fois.
//
// Ce qu'elle fait :
//   - relève chaque seconde le tas wasm UTILISÉ et RÉSERVÉ (unityInstance.GetMetricsInfo), trois minutes gardées ;
//   - garde les derniers CONTEXTES que le jeu lui envoie (tour, phase, décision, nombre de rendus dans l'image —
//     WebSonde.cs) et le dernier DUMP DE PARTIE rejouable (le même que celui d'un signalement) ;
//   - au plantage (abort, OOM, RuntimeError), dépose un SIGNALEMENT AUTOMATIQUE dans card_reports — il arrive dans
//     l'atelier des signalements sous la carte « Plantage du jeu (mémoire) », dump joint, relevés dans dump.sonde ;
//   - s'il n'a pas pu partir (réseau, onglet fermé trop tôt), il est gardé dans le localStorage et renvoyé au
//     lancement suivant.
// Elle ne fait rien d'autre : aucune décision de jeu, aucun envoi tant que le jeu ne plante pas.
(function () {
  'use strict';

  var CLE_ATTENTE = 'motn_sonde_rapport_en_attente';
  var MAX_RELEVES = 180;      // un par seconde : trois minutes
  var MAX_CONTEXTES = 60;

  var S = {
    conf: null,               // url, cle, build, lang, joueurId, joueurNom (WebSonde.Configurer)
    instance: null,           // unityInstance (attacher)
    releves: [],
    contextes: [],
    dernierContexte: '',
    dump: null,               // dernier GameDump (JSON texte)
    dumpA: 0,
    pic: { utilise: 0, t: 0, contexte: '' },
    erreurs: [],              // erreurs JS non fatales vues avant le plantage (les dernières)
    plante: false,
    debut: Date.now()
  };

  function t() { return Math.round(performance.now() / 1000); }
  function mo(octets) { return octets ? Math.round(octets / 104857.6) / 10 : 0; }

  function relever() {
    if (!S.instance || typeof S.instance.GetMetricsInfo !== 'function') return null;
    try {
      var m = S.instance.GetMetricsInfo();
      var r = {
        t: t(),
        utilise: mo(m.usedWASMHeapSize),
        reserve: mo(m.totalWASMHeapSize),
        js: m.usedJSHeapSize ? mo(m.usedJSHeapSize) : null,
        fps: Math.round(m.fps || 0)
      };
      S.releves.push(r);
      if (S.releves.length > MAX_RELEVES) S.releves.shift();
      if (r.utilise > S.pic.utilise) S.pic = { utilise: r.utilise, t: r.t, contexte: S.dernierContexte };
      return r;
    } catch (e) {
      return null;            // module déjà arrêté : on garde ce qu'on a
    }
  }

  function dernierUtilise() {
    var r = S.releves.length ? S.releves[S.releves.length - 1] : null;
    return r ? r.utilise : null;
  }

  function envoyer(rapport, auLancementSuivant) {
    var c = S.conf;
    if (!c || !c.url || !c.cle) return Promise.resolve(false);
    if (auLancementSuivant) rapport.message = '[renvoyé au lancement suivant] ' + rapport.message;
    return fetch(c.url.replace(/\/+$/, '') + '/rest/v1/card_reports', {
      method: 'POST',
      headers: {
        'apikey': c.cle,
        'Authorization': 'Bearer ' + c.cle,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify(rapport)
    }).then(function (rep) { return rep.ok; }).catch(function () { return false; });
  }

  function garder(rapport) {
    try { localStorage.setItem(CLE_ATTENTE, JSON.stringify(rapport)); } catch (e) { /* plein ou interdit */ }
  }

  function oublier() {
    try { localStorage.removeItem(CLE_ATTENTE); } catch (e) { /* rien */ }
  }

  function renvoyerEnAttente() {
    var brut = null;
    try { brut = localStorage.getItem(CLE_ATTENTE); } catch (e) { return; }
    if (!brut) return;
    var rapport;
    try { rapport = JSON.parse(brut); } catch (e) { oublier(); return; }
    envoyer(rapport, true).then(function (ok) { if (ok) oublier(); });
  }

  function navigateurCourt() {
    var ua = navigator.userAgent || '';
    var m = ua.match(/(Firefox|Edg|OPR|Chrome|Safari)\/(\d+)/);
    return m ? (m[1] === 'Edg' ? 'Edge' : m[1]) + ' ' + m[2] : ua.slice(0, 60);
  }

  function estFatal(message) {
    return /abort\(|OOM|Cannot enlarge memory|out of memory|RuntimeError|unreachable/i.test(message || '');
  }

  function plantage(message) {
    message = String(message || '');
    if (!estFatal(message)) {
      S.erreurs.push({ t: t(), message: message.slice(0, 400) });
      if (S.erreurs.length > 10) S.erreurs.shift();
      return;
    }
    if (S.plante) return;
    S.plante = true;
    relever();                // dernière chance (souvent impossible : le module vient d'avorter)

    var memoire = /OOM|enlarge memory|out of memory|CannotGrowMemory/i.test(message);
    var canvas = document.querySelector('#unity-canvas');
    var sonde = {
      kind: 'motn_sonde_v1',
      erreur: message.slice(0, 6000),
      quand: new Date().toISOString(),
      dureeSession_s: Math.round((Date.now() - S.debut) / 1000),
      navigateur: navigator.userAgent,
      memoireAppareil_go: navigator.deviceMemory || null,
      ecran: {
        largeur: screen.width, hauteur: screen.height, dpr: window.devicePixelRatio,
        canvas: canvas ? [canvas.width, canvas.height] : null,
        pleinEcran: !!(document.fullscreenElement || document.mozFullScreenElement)
      },
      pic: S.pic,
      releves: S.releves,
      contextes: S.contextes,
      contexteFinal: S.dernierContexte,
      dumpAge_s: S.dump ? Math.round((Date.now() - S.dumpA) / 1000) : null,
      erreursAvant: S.erreurs
    };

    var dump, dumpKind;
    if (S.dump) {
      try {
        var d = JSON.parse(S.dump);
        d.sonde = sonde;
        dump = JSON.stringify(d);
        dumpKind = d.kind || 'vtes_match_dump_v1';
      } catch (e) { dump = null; }
    }
    if (!dump) { dump = JSON.stringify({ kind: 'motn_sonde_v1', sonde: sonde }); dumpKind = 'motn_sonde_v1'; }

    var u = dernierUtilise();
    var r0 = S.releves.length ? S.releves[S.releves.length - 1] : null;
    var c = S.conf || {};
    var rapport = {
      card_name: memoire ? 'Plantage du jeu (mémoire)' : 'Plantage du jeu',
      kind: 'bug',
      message: 'Signalement AUTOMATIQUE (sonde) : le jeu web s\'est arrêté. '
        + (u !== null ? 'Tas utilisé au dernier relevé : ' + u + ' Mo sur ' + (r0 ? r0.reserve : '?') + ' Mo réservés ; ' : '')
        + 'pic de la session : ' + S.pic.utilise + ' Mo. '
        + 'Dernier contexte : ' + (S.dernierContexte || 'aucun') + '. '
        + 'Erreur : ' + message.split('\n')[0].slice(0, 300),
      lang: c.lang || null,
      context: 'scene=' + (c.scene || '?') + ' build=' + (c.build || '?') + ' plateforme=WebGLPlayer navigateur='
        + navigateurCourt() + ' source=sonde',
      player_id: c.joueurId || null,
      player_name: c.joueurNom || null,
      dump: dump,
      dump_kind: dumpKind
    };

    garder(rapport);
    envoyer(rapport, false).then(function (ok) { if (ok) oublier(); });
  }

  window.MotnSonde = {
    // Appelé par le gabarit dès que l'instance Unity existe.
    attacher: function (instance) {
      S.instance = instance;
      relever();
      setInterval(relever, 1000);
    },
    // Les trois entrées du jeu (MotnSonde.jslib, WebSonde.cs).
    configurer: function (json) {
      var premiere = !S.conf;
      try { S.conf = JSON.parse(json); } catch (e) { return; }
      if (premiere) renvoyerEnAttente();
    },
    contexte: function (texte) {
      if (texte === S.dernierContexte) return;
      S.dernierContexte = texte;
      S.contextes.push({ t: t(), utilise: dernierUtilise(), contexte: texte });
      if (S.contextes.length > MAX_CONTEXTES) S.contextes.shift();
    },
    dump: function (json) {
      S.dump = json;
      S.dumpA = Date.now();
    },
    // Le plantage, signalé par le gabarit (config.errorHandler) et par les écouteurs ci-dessous.
    plantage: plantage,
    // Lecture pour le diagnostic à la main (console du navigateur).
    etat: function () {
      return { releves: S.releves.length, dernier: S.releves[S.releves.length - 1], pic: S.pic,
               contexte: S.dernierContexte, dumpAge_s: S.dump ? Math.round((Date.now() - S.dumpA) / 1000) : null,
               configure: !!S.conf };
    }
  };

  // Posés AVANT ceux du chargeur Unity : ils voient l'erreur avant la boîte d'alerte qui bloque la page.
  window.addEventListener('error', function (e) {
    var err = e && e.error;
    plantage((err && err.toString ? err.toString() : '') + ' ' + (e && e.message ? e.message : '')
      + (err && err.stack ? '\n' + err.stack : ''));
  });
  window.addEventListener('unhandledrejection', function (e) {
    var r = e && e.reason;
    plantage((r && r.toString ? r.toString() : String(r)) + (r && r.stack ? '\n' + r.stack : ''));
  });
})();
