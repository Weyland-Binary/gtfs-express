---
title: Choisir un outil pour modifier un GTFS, les critères qui comptent
description: Les critères pour choisir un outil qui modifie un GTFS (preuve, validation, versions, données, cahier des charges, décision) et les réponses de GTFS Express.
updated: 2026-10-21
slug: choisir-un-outil-pour-modifier-un-gtfs
---

Un outil de modification GTFS se juge sur ce qu'il permet de changer, sur la façon dont il montre que le changement est juste, et sur ce qu'il fait de vos données. Les critères ci-dessous valent pour n'importe quel outil ; pour chacun, la réponse de GTFS Express est donnée telle quelle, sans comparaison.

## Ce que l'outil peut changer

Un changement d'offre touche rarement un seul fichier. Ajouter un arrêt, c'est `stops.txt`, `stop_times.txt` et souvent `shapes.txt` ; une période de travaux, c'est `calendar_dates.txt` et des courses copiées. Un outil limité aux horaires oblige à finir le travail ailleurs, avec le risque de références cassées entre les deux.

À vérifier : les fichiers et les champs modifiables, la création et la suppression d'objets, la gestion des calendriers, des tracés et des identifiants.

GTFS Express : à la main, dans le lecteur, les arrêts, les horaires, les tracés et n'importe quel champ ; ou à partir d'un cahier des charges, modifié par un agent d'IA sur une copie du réseau.

## Comment il prouve que le changement est juste

Une ligne plausible sur une carte ne prouve pas que le cahier des charges est respecté. Ce qui prouve, c'est une mesure : la demande vérifiée sur le réseau modifié, à une date qu'elle concerne et à une date qu'elle ne concerne pas, et la liste de ce qui a changé sans être demandé.

À vérifier : ce que l'outil montre après un changement (une comparaison avant et après, table par table), et s'il signale les changements involontaires.

GTFS Express : le moteur établit les faits du changement (ce qui a changé par table, les nouvelles erreurs du validateur) ; une revue indépendante, menée par un autre modèle que celui qui a fait le changement, vérifie chaque demande sur la copie et la déclare faite, non faite ou non prouvée, avec ses preuves et les changements que personne n'a demandés.

## La validation

À vérifier : quel validateur, dans quelle version, à quel moment, et si l'outil distingue les erreurs que le changement crée de celles qui existaient déjà.

GTFS Express : le validateur GTFS canonique, en version 8.0.0. Une nouvelle erreur bloque la livraison ; les erreurs déjà présentes dans le jeu de référence s'acceptent nommément. Le catalogue compte 178 règles (117 erreurs, 54 avertissements, 7 informations), et le rapport ouvre chaque occurrence dans l'éditeur, le champ signalé. Voir [Valider un GTFS](/guides/valider-un-gtfs).

## Les versions et le retour en arrière

Un réseau modifié doit pouvoir être comparé à l'état précédent, et un changement livré doit pouvoir être défait.

À vérifier : où se fait le changement (sur le réseau publié ou sur une copie), comment on compare, comment on annule.

GTFS Express : chaque changement se fait dans un brouillon séparé du réseau de travail. « Avant » montre le réseau tel qu'il est, « Après » le brouillon. Appliquer crée une nouvelle version (v1, v2...), et chaque version peut être annulée. Deux versions se comparent.

## Les données et leur confidentialité

Un GTFS est public, mais un cahier des charges contient souvent des noms, des adresses e-mail, des éléments internes. Si l'outil fait appel à un modèle d'IA, la question est ce qui lui est envoyé.

À vérifier : ce qui part vers un service externe, et ce qui est masqué avant.

GTFS Express : les noms et adresses e-mail sont masqués avant tout envoi au modèle d'IA.

## Les formats de cahier des charges

Un cahier des charges arrive rarement en texte simple : un courrier en PDF, une note Word, des grilles horaires dans un tableur.

À vérifier : les formats lus, et ce que fait l'outil quand une demande est ambiguë ou incomplète.

GTFS Express : le cahier des charges se donne en texte ou en documents (PDF, Word, Excel). Quand une demande se lit de deux façons ou qu'une donnée manque, comme la position d'un nouvel arrêt, l'agent pose une question au lieu de deviner.

## Qui décide

Un outil propose ; quelqu'un doit décider, et cette décision doit rester attachée à ce qui a été livré.

À vérifier : qui valide le changement, et si la décision est enregistrée avec le jeu livré.

GTFS Express : la personne décide sous son nom. Le paquet livré contient le GTFS et son rapport, et garde la décision.

## Lire avant de modifier

Avant tout changement, il faut lire le réseau : ses lignes, ses horaires, ses erreurs. Un outil qui permet de lire sans engagement aide à décider si le changement vaut la peine.

GTFS Express : la lecture est gratuite et sans compte (carte, lignes, horaires jour par jour, rapport du validateur, diagnostic au-delà du validateur, comparaison de deux versions, partage par un lien). La modification demande une licence.

## Pour aller plus loin

- [Du cahier des charges au GTFS](/guides/du-cahier-des-charges-au-gtfs)
- [Modifier un GTFS](/guides/modifier-un-gtfs)
- [Valider un GTFS](/guides/valider-un-gtfs)
