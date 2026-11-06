---
title: Vacances scolaires et jours fériés dans un GTFS
description: Écrire les périodes scolaires, les vacances par zone A, B ou C et les jours fériés avec calendar.txt et calendar_dates.txt, et éviter les pièges courants.
updated: 2026-10-21
slug: vacances-scolaires-et-jours-feries-dans-un-gtfs
---

GTFS ne connaît ni les vacances scolaires ni les jours fériés : il ne connaît que des dates. On les écrit avec `calendar.txt`, qui donne des jours de la semaine sur une plage de dates, et `calendar_dates.txt`, qui ajoute ou retire des dates précises. En pratique, un réseau a un service par période (scolaire, vacances, samedi, dimanche et fêtes) et une exception par jour férié.

## calendar.txt et calendar_dates.txt

Une ligne de `calendar.txt` décrit un service : `service_id`, les sept colonnes `monday` à `sunday` (1 ou 0), `start_date` et `end_date` au format `AAAAMMJJ`, toutes deux incluses. Un `service_id` n'y apparaît qu'une fois : un service n'a qu'une plage de dates.

Une ligne de `calendar_dates.txt` modifie un service à une date : `exception_type` 1 ajoute la date, 2 la retire. Un service peut n'exister que dans `calendar_dates.txt`, chaque jour de circulation y étant une ligne de type 1.

Un service circule à une date D quand D est dans sa plage, que la colonne du jour vaut 1 et qu'aucune exception de type 2 ne retire D, ou quand une exception de type 1 ajoute D. Chaque course (`trips.txt`) a un seul `service_id`.

## Un service par période

Comme un service n'a qu'une plage de dates et qu'une course n'a qu'un service, la structure la plus courante est la suivante :

- un service « semaine scolaire » sur toute l'année, du lundi au vendredi, avec une exception de type 2 sur chaque jour de vacances ;
- un service « semaine vacances » défini uniquement par des dates de type 1, les jours de vacances du lundi au vendredi ;
- un service « samedi », éventuellement scindé de la même façon ;
- un service « dimanche et fêtes ».

```
service_id,monday,tuesday,wednesday,thursday,friday,saturday,sunday,start_date,end_date
SCO,1,1,1,1,1,0,0,20260901,20270703
SAM,0,0,0,0,0,1,0,20260901,20270703
DF,0,0,0,0,0,0,1,20260901,20270703
```

Pour une semaine de vacances (dates d'exemple), le service scolaire perd chaque jour et le service vacances le gagne :

```
service_id,date,exception_type
SCO,20261019,2
VAC,20261019,1
SCO,20261020,2
VAC,20261020,1
```

Découper l'année en plusieurs services scolaires (un par période entre deux vacances) est possible, mais il faut alors dupliquer chaque course sur chacun d'eux. La plupart des réseaux préfèrent un service et des exceptions.

## Les zones A, B et C

En France métropolitaine, le calendrier scolaire est fixé par le ministère de l'Éducation nationale et publié en données ouvertes. Les vacances de la Toussaint, de Noël et d'été ont les mêmes dates partout. Les vacances d'hiver et de printemps sont décalées selon trois zones, A, B et C, définies par académie. La Corse et les académies d'outre-mer ont leur propre calendrier.

Prenez les dates de la zone du réseau, pas celles d'une zone voisine. Si le réseau dessert des établissements de deux zones différentes, les courses scolaires de chaque zone ont besoin de leur propre service.

Le calendrier officiel donne la fin des cours et le jour de reprise. Les vacances sont les jours entre les deux : le jour de reprise est un jour scolaire. Le calendrier prévoit aussi un pont de l'Ascension ; vérifiez si votre réseau le traite comme un jour scolaire ou de vacances.

Les autres pays publient leurs calendriers scolaires à leur façon, mais côté GTFS le principe ne change pas : des dates, écrites dans des services.

## Les jours fériés

La France compte onze jours fériés : 1er janvier, lundi de Pâques, 1er mai, 8 mai, Ascension, lundi de Pentecôte, 14 juillet, 15 août, 1er novembre, 11 novembre et 25 décembre. L'Alsace et la Moselle ajoutent le Vendredi saint et le 26 décembre. Pâques, l'Ascension et la Pentecôte changent de date chaque année.

Beaucoup de réseaux font circuler le service du dimanche les jours fériés. Pour chaque férié tombant en semaine, on retire la date du service qui circulerait ce jour-là et on l'ajoute au service du dimanche. Le 11 novembre 2026 est un mercredi en période scolaire :

```
service_id,date,exception_type
SCO,20261111,2
DF,20261111,1
```

Les pratiques varient : certains réseaux font rouler un service de samedi le lundi de Pentecôte, d'autres réduisent encore l'offre le 1er mai ou ne circulent pas ce jour-là. Lisez ce que fait le jeu existant avant d'ajouter une date. Un férié tombant un dimanche ne demande rien ; un férié tombant un samedi se retire du service du samedi.

## Les pièges courants

- **Un férié pendant les vacances.** La date est à retirer du service vacances, pas du service scolaire. Si le service vacances n'existe que par des dates de type 1, supprimez la ligne de type 1 au lieu d'ajouter une ligne de type 2 : le couple `service_id` et `date` est une clé, et deux lignes déclenchent [duplicate_key](/regles/duplicate_key).
- **Le nom du service.** Un service nommé « VAC » ne prouve rien. Vérifiez les dates auxquelles il circule réellement.
- **Les courses après minuit.** Une course de 0 h 30 la nuit du 13 au 14 juillet s'écrit `24:30:00` sur le service du 13 : c'est la veille qui décide.
- **Un service vidé.** Un service dont toutes les colonnes de jours valent 0 et qui n'a aucune date de type 1 ne circule jamais : [service_without_service_days](/regles/service_without_service_days).
- **La fin de validité.** Un `end_date` passé déclenche [expired_calendar](/regles/expired_calendar), et une fin de jeu proche [feed_expiration_date_30_days](/regles/feed_expiration_date_30_days). Prolonger un jeu sur l'année suivante, c'est aussi ajouter les vacances et les fériés de cette année-là.
- **« En semaine ».** Dans un cahier des charges, « du lundi au vendredi » inclut les vacances scolaires, sauf mention « en période scolaire ».

Pour contrôler le résultat, regardez les horaires d'une ligne à une date précise : un jour de classe, un jour de vacances, un jour férié en semaine. Le lecteur de GTFS Express affiche les horaires jour par jour, gratuitement et sans compte, ce qui permet ce contrôle avant et après un changement.

## Pour aller plus loin

- [Modifier un GTFS](/guides/modifier-un-gtfs)
- [Du cahier des charges au GTFS](/guides/du-cahier-des-charges-au-gtfs)
- [Valider un GTFS](/guides/valider-un-gtfs)
