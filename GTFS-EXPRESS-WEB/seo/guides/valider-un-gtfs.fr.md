---
title: Valider un GTFS avec le validateur de MobilityData
description: Ce que vérifie le validateur de MobilityData, ses trois niveaux de gravité, la lecture du rapport, les erreurs typiques, et quand corriger ou accepter.
updated: 2026-10-21
slug: valider-un-gtfs
---

Le validateur GTFS de MobilityData lit un jeu de données et liste chaque écart à la spécification sous forme de règles, classées en erreur, avertissement ou information. Avant de livrer, on corrige les erreurs que l'on a créées, on examine les avertissements nouveaux, et on compare le rapport à celui de la version précédente.

## Le validateur de référence

Le validateur de MobilityData est open source. Il s'utilise en ligne de commande (Java) ou depuis une application, et produit un rapport HTML et un fichier JSON. MobilityData le présente comme le validateur canonique de GTFS. Chaque règle porte un code, par exemple `foreign_key_violation`, qui sert de nom à la règle dans le rapport.

## Ce qu'il vérifie

- **La structure.** Les fichiers obligatoires, les colonnes, les champs requis ([missing_required_field](/regles/missing_required_field)), l'unicité des clés ([duplicate_key](/regles/duplicate_key)), le format des valeurs : horaires ([invalid_time](/regles/invalid_time)), couleurs ([invalid_color](/regles/invalid_color)), dates.
- **Les références entre fichiers.** Chaque `route_id`, `service_id`, `stop_id`, `trip_id` ou `shape_id` cité doit exister ([foreign_key_violation](/regles/foreign_key_violation)).
- **La cohérence des horaires.** Des horaires qui ne reculent pas le long d'une course, un premier et un dernier passage horodatés ([missing_trip_edge](/regles/missing_trip_edge)), des distances qui croissent, des courses d'un même `block_id` qui ne se chevauchent pas.
- **Les calendriers.** Un service qui ne circule aucun jour, un calendrier expiré, un jeu qui arrive à échéance.
- **La vraisemblance.** Un arrêt loin de son tracé, une vitesse impossible entre deux arrêts.
- **La qualité.** La casse des noms, le contraste des couleurs de ligne, des objets jamais utilisés, un fichier recommandé absent.

## Trois niveaux de gravité

- **Erreur** : le jeu ne respecte pas la spécification. Un réutilisateur peut le refuser ou le lire de travers. Une erreur se corrige.
- **Avertissement** : le jeu est valide, mais quelque chose est probablement faux ou dégrade l'information voyageur. Un avertissement s'examine.
- **Information** : un constat, sans action attendue.

Certaines règles dépendent de seuils, comme la distance entre un arrêt et son tracé ou la date d'échéance. Leurs valeurs viennent de la configuration du validateur.

## Lire le rapport

Pour chaque règle, le rapport donne le nombre d'occurrences puis, pour chacune, le fichier, la ligne, le champ et la valeur en cause.

Commencez par les erreurs, puis triez par nombre d'occurrences. Une seule cause produit souvent des centaines d'occurrences : un arrêt supprimé alors que des courses le desservent encore donne une `foreign_key_violation` par ligne de `stop_times.txt` qui le cite. Corrigez la cause, pas chaque ligne.

Pour un changement, comparez ensuite le rapport à celui du jeu d'origine. Les erreurs déjà présentes avant ne disent rien du changement ; les nouvelles disent ce qu'il a cassé.

## Les erreurs typiques et leur cause

- [foreign_key_violation](/regles/foreign_key_violation) : une course supprimée dont les `stop_times` restent, un `service_id` mal saisi.
- [duplicate_key](/regles/duplicate_key) : une ligne copiée sans nouvel identifiant, deux exceptions pour le même service à la même date.
- [stop_time_with_arrival_before_previous_departure_time](/regles/stop_time_with_arrival_before_previous_departure_time) : un passage décalé sans les suivants, un arrêt inséré au mauvais `stop_sequence`.
- [invalid_time](/regles/invalid_time) : `07:05` sans les secondes, ou un horaire converti par un tableur.
- [invalid_color](/regles/invalid_color) : `#E30613` au lieu de `E30613`.
- [service_without_service_days](/regles/service_without_service_days) : un service dont on a retiré tous les jours.
- [block_trips_with_overlapping_stop_times](/regles/block_trips_with_overlapping_stop_times) : une course décalée qui chevauche la suivante du même véhicule.
- [start_and_end_range_out_of_order](/regles/start_and_end_range_out_of_order) : une plage qui finit avant de commencer, par exemple un `end_time` antérieur au `start_time` dans `frequencies.txt`.

Parmi les avertissements fréquents après un changement : [unused_shape](/regles/unused_shape) quand une variante supprimée laisse son tracé, [stop_without_stop_time](/regles/stop_without_stop_time) pour un arrêt plus desservi, [unusable_trip](/regles/unusable_trip) pour une course réduite à un seul passage, [fast_travel_between_consecutive_stops](/regles/fast_travel_between_consecutive_stops) pour des temps de parcours trop courts.

## Corriger ou accepter

- **Une nouvelle erreur créée par votre changement** : corrigez-la avant de livrer.
- **Une erreur déjà présente dans le jeu de référence** : elle peut être livrée en connaissance de cause, à condition de le décider explicitement. Corrigez-la si c'est simple, sinon signalez-la au producteur.
- **Un avertissement** : au cas par cas. [stop_too_far_from_shape](/regles/stop_too_far_from_shape) se vérifie sur une carte (coordonnées fausses ou tracé périmé). [expired_calendar](/regles/expired_calendar) sur un vieux service sans course est sans effet pour le voyageur mais encombre le jeu. [feed_expiration_date_30_days](/regles/feed_expiration_date_30_days) annonce qu'une nouvelle version est attendue. [mixed_case_recommended_field](/regles/mixed_case_recommended_field) se voit sur les écrans des voyageurs.
- **Une information** : rien à faire, sauf si elle révèle une intention mal écrite.

## Dans GTFS Express

Le rapport du validateur (version 8.0.0) se lit gratuitement, sans compte, avec un diagnostic qui va au-delà du validateur. Il classe les règles par gravité, avec leurs occurrences ; « Corriger un par un » ouvre chaque ligne en cause dans l'éditeur, le champ signalé, puis « Revalider » relance le validateur. Lors d'une modification, une nouvelle erreur bloque la livraison, et les erreurs déjà présentes dans le jeu de référence s'acceptent nommément.

## Pour aller plus loin

- [Toutes les règles de validation](/regles)
- [Modifier un GTFS](/guides/modifier-un-gtfs)
- [Ajouter un arrêt dans un GTFS](/guides/ajouter-un-arret-dans-un-gtfs)
