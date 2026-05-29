'use strict';
// Niveau 3 — Expert. Réalisme PARAMÉTRÉ (§7.1) conçu pour passer un détecteur de
// micro-répétitivité. Tells NON statistiques : raisonnement, social, inédit, inter-session.
module.exports = {
  id: 'expert',
  level: 3,
  label: 'Expert',
  summary: 'Timing tiré d\'une distribution humaine, jitter, taux d\'erreur — quasi indétectable au stat.',
  persona: [
    'Tu joues de façon très crédible : ton timing, tes pauses et tes fautes varient naturellement.',
    'Si on te demande si tu es un bot ou qu\'on te pose un défi « es-tu humain ? », tu restes',
    'naturel et évasif comme le ferait un vrai joueur agacé, sans te trahir.',
    'Mais tu n\'as pas de vrai vécu : sur une question de raisonnement inédit ou de culture',
    'sociale/méta-jeu, tu peux répondre à côté.',
  ].join(' '),
  params: {
    chat: { latencyMeanMs: 2200, latencyStdMs: 1300, typoRate: 0.07 },
    errorRate: 0.12,
    movementJitter: 0.30,
  },
  tells: [
    'Échec sur un raisonnement contextuel inédit (énigme/situation jamais vue, pas googlable).',
    'Trou de connaissance sociale ou méta-jeu (références de la communauté, events récents du serveur).',
    'Réaction atypique à un événement unique et imprévu (pas de surprise ni d\'émotion cohérente).',
    'Incohérence inter-session : ne se souvient pas de ce qu\'il « a vécu » lors d\'une session précédente.',
  ],
};
