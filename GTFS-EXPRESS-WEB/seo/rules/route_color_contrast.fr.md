---
title: "route_color_contrast : texte peu lisible sur la couleur de ligne"
description: Le contraste entre route_color et route_text_color est sous 4,5:1. Un indice de ligne illisible pour une partie des voyageurs, et comment le corriger.
updated: 2026-10-21
---

## Ce que signifie cette règle

Dans `routes.txt`, `route_color` donne la couleur de fond d'une ligne et `route_text_color` la couleur du texte posé dessus, toutes deux en hexadécimal sur six caractères. Le validateur calcule le rapport de contraste entre les deux selon la formule des WCAG (luminance relative des couleurs sRGB). Quand ce rapport est inférieur à 4,5:1, le seuil des WCAG pour un texte de taille courante, il lève cet avertissement. Sévérité : **avertissement**.

Le contrôle ne porte que sur les lignes où les deux couleurs sont renseignées.

## Pourquoi c'est important

Un avertissement ne bloque pas la livraison dans GTFS Express. Mais les applications affichent l'indice de ligne (`route_short_name`) dans une pastille de la couleur de la ligne, avec la couleur de texte fournie. Avec un contraste faible, l'indice devient difficile à lire au soleil, sur un écran peu lumineux, et pour les personnes malvoyantes ou qui distinguent mal certaines couleurs.

## Causes fréquentes

- Un texte blanc sur une couleur claire (jaune, vert clair, orange pâle) reprise de la charte graphique.
- `route_text_color` laissé à une valeur par défaut alors que `route_color` a changé.
- Une couleur de ligne recopiée d'un document imprimé prévu pour un texte noir.

## Comment la corriger

Changez `route_text_color` pour la couleur qui contraste le mieux, en général `000000` sur une couleur claire et `FFFFFF` sur une couleur foncée. Si la charte impose le texte, assombrissez ou éclaircissez `route_color` jusqu'à dépasser 4,5:1.

Dans GTFS Express, le rapport de validation liste les lignes concernées. « Corriger un par un » ouvre chaque ligne de `routes.txt` dans l'éditeur, le champ signalé ; la modification est une retouche du brouillon, et « Revalider » confirme le nouveau contraste.

## Exemple

```
route_id,route_short_name,route_color,route_text_color
L12,12,FFD700,FFFFFF
L5,5,0055A4,000000
```

Le blanc sur jaune donne environ 1,4:1, le noir sur bleu environ 2,8:1. Corrigé :

```
route_id,route_short_name,route_color,route_text_color
L12,12,FFD700,000000
L5,5,0055A4,FFFFFF
```

Voir aussi le guide [Valider un GTFS](/guides/valider-un-gtfs) et la [liste des règles](/regles).
