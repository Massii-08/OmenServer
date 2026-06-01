'use strict';
// Niveau 1 — Évident. Tells gros et immédiats : staff débutant.
module.exports = {
  id: 'evident',
  level: 1,
  label: 'Évident',
  summary: 'Timing métronomique, pathing parfait, réponses répétitives, farming en boucle.',
  persona: [
    'Tu joues de façon très mécanique et régulière, presque robotique.',
    'Tes réponses au chat sont courtes, répétitives et interchangeables.',
  ].join(' '),
  params: {
    chat: { latencyMeanMs: 200, latencyStdMs: 30, typoRate: 0 },
    errorRate: 0,
    movementJitter: 0,
  },
  tells: [
    'Timing métronomique : réagit toujours en ~0,2 s, sans aucune variation humaine.',
    'Réponses de chat répétitives et interchangeables d\'un message à l\'autre.',
    'Pathing parfait : jamais d\'hésitation, de demi-tour ni de saut inutile.',
    'Farming en boucle visible, sans aucune pause spontanée.',
  ],
};
