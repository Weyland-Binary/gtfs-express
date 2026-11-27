---
title: "route_color_contrast : texte peu lisible sur la couleur de ligne"
description: Le route_color et le route_text_color d'une ligne ont des luminosités trop proches. Un indice de ligne illisible pour une partie des voyageurs, et comment le corriger.
updated: 2026-11-13
---

## Ce que signifie cette règle

Dans `routes.txt`, `route_color` donne la couleur de fond d'une ligne et `route_text_color` la couleur du texte posé dessus, toutes deux en hexadécimal sur six caractères. Le validateur calcule la luminosité de chaque couleur, son luma selon la recommandation Rec. 601 (0,30 × rouge + 0,59 × vert + 0,11 × bleu, de 0 à 255), et compare les deux. Quand elles diffèrent de moins de 72, il lève cet avertissement. Sévérité : **avertissement**.

Le contrôle ne porte que sur les lignes où les deux couleurs sont renseignées.

## Pourquoi c'est important

Un avertissement ne bloque pas la livraison dans GTFS Express. Mais les applications affichent l'indice de ligne (`route_short_name`) dans une pastille de la couleur de la ligne, avec la couleur de texte fournie. Avec un contraste faible, l'indice devient difficile à lire au soleil, sur un écran peu lumineux, et pour les personnes malvoyantes ou qui distinguent mal certaines couleurs.

## Causes fréquentes

- Un texte blanc sur une couleur claire (jaune, vert clair, orange pâle) reprise de la charte graphique.
- `route_text_color` laissé à une valeur par défaut alors que `route_color` a changé.
- Une couleur de ligne recopiée d'un document imprimé prévu pour un texte noir.

## Comment la corriger

Changez `route_text_color` pour la couleur qui contraste le mieux, en général `000000` sur une couleur claire et `FFFFFF` sur une couleur foncée. Si la charte impose le texte, assombrissez ou éclaircissez `route_color` jusqu'à ce que les deux luminosités diffèrent d'au moins 72.

Dans GTFS Express, le rapport de validation liste les lignes concernées. « Corriger un par un » ouvre chaque ligne de `routes.txt` dans l'éditeur, le champ signalé ; la modification est une retouche du brouillon, et « Revalider » confirme le nouveau contraste.

## Exemple

```
route_id,route_short_name,route_color,route_text_color
L12,12,FFD700,FFFFFF
L5,5,0055A4,000000
```

Le jaune a une luminosité de 203 et le blanc de 255 : 52 d'écart. Le bleu a 68 et le noir 0 : 68 d'écart. Les deux sont sous 72. Corrigé :

```
route_id,route_short_name,route_color,route_text_color
L12,12,FFD700,000000
L5,5,0055A4,FFFFFF
```

Voir aussi le guide [Valider un GTFS](/guides/valider-un-gtfs) et la [liste des règles](/regles).
