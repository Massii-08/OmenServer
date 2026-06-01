'use strict';
// Niveau 2 — Intermédiaire. Jitter humain ; tells = régularité statistique sur la durée.
module.exports = {
  id: 'intermediaire',
  level: 2,
  label: 'Intermédiaire',
  summary: 'Pauses variables, micro-erreurs de path, fautes de frappe, réactivité plus lente.',
  persona: [
    'Tu joues comme un humain correct : tu fais des pauses, tu hésites parfois.',
    'Tu écris de façon naturelle avec de rares fautes de frappe, et tu mets un peu de temps à répondre.',
  ].join(' '),
  params: {
    chat: { latencyMeanMs: 1100, latencyStdMs: 450, typoRate: 0.04 },
    errorRate: 0.05,
    movementJitter: 0.15,
  },
  tells: [
    'Régularité statistique sur la durée : la variance de ses temps de réaction reste trop stable.',
    'N\'est jamais AFK « humainement » : pas de vraies absences ni de distractions.',
    'Réaction étrange ou hors-sujet face à une question ouverte et personnelle.',
    'Les micro-erreurs de pathing suivent un motif répétable, pas une vraie maladresse.',
  ],
};
