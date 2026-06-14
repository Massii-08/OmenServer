'use strict';
// Capture-clone étape D (« LA COPIE ») : rejeu de la MOTRICITÉ humaine réelle. Les clips distillés
// (backend/bots/mc_capture_distill.py → clips/<ctx>.json) sont des séquences courtes de frames
// {in:{fwd,atk,…}, dyaw, dpitch} taggées par contexte. createClipPlayer marche ces frames et fournit
// les Δyaw/Δpitch HUMAINS (degrés) à appliquer à la visée du bot — on rejoue COMMENT l'humain bougeait
// la caméra, par-dessus le QUOI déterministe du bot (anti snap-aim, le tell n°1). PUR (rng injectable),
// stdlib only. Sans --clips → non instancié → comportement inchangé (rétro-compat).
const fs = require('fs');
const path = require('path');

const CTXS = ['idle', 'turn', 'mine', 'combat', 'locomotion'];

// Charge clips/<ctx>.json depuis un dossier distillé. → { ctx: [clips] }. Best-effort (ctx absent → skip).
function loadClips(dir) {
  const out = {};
  if (!dir) return out;
  for (const ctx of CTXS) {
    try {
      const arr = JSON.parse(fs.readFileSync(path.join(String(dir), ctx + '.json'), 'utf8'));
      if (Array.isArray(arr) && arr.length) out[ctx] = arr;
    } catch (e) { /* ctx absent/illisible → skip */ }
  }
  return out;
}

/**
 * Rejoueur de motricité : marche les frames d'un clip humain du contexte courant ; à la fin d'un clip
 * (ou si le contexte change) en tire un NOUVEAU au hasard dans ce contexte. next(ctx) → {dyaw,dpitch,in}
 * (degrés) ou null (pas de clip pour ce ctx → l'appelant garde nextLook/le défaut). PUR (rng injectable).
 */
function createClipPlayer(clipsByCtx, rng = Math.random) {
  let curCtx = null;
  let clip = null;
  let i = 0;
  function pick(ctx) {
    const arr = clipsByCtx && clipsByCtx[ctx];
    if (!arr || !arr.length) return null;
    return arr[Math.floor(rng() * arr.length)] || null;
  }
  return {
    next(ctx) {
      const frames = clip && clip.frames;
      if (ctx !== curCtx || !frames || i >= frames.length) {
        curCtx = ctx;
        clip = pick(ctx);
        i = 0;
      }
      if (!clip || !clip.frames || !clip.frames.length) return null;
      const f = clip.frames[i++];
      return {
        dyaw: Number(f.dyaw) || 0,
        dpitch: Number(f.dpitch) || 0,
        in: f.in || {},
        ctx: curCtx,
        player: clip.player,
      };
    },
    has(ctx) { return !!(clipsByCtx && clipsByCtx[ctx] && clipsByCtx[ctx].length); },
    _state() { return { curCtx, i, clipLen: (clip && clip.frames) ? clip.frames.length : 0 }; },
  };
}

module.exports = { loadClips, createClipPlayer, CTXS };
