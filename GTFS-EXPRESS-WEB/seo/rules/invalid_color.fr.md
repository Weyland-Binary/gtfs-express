---
title: "invalid_color : couleur de ligne mal formée dans routes.txt"
description: route_color ou route_text_color n'est pas un code hexadécimal de six caractères. Les formats refusés par invalid_color et la façon de les corriger.
updated: 2026-10-21
---

## Ce que signifie cette règle

Les champs de couleur de GTFS, `route_color` et `route_text_color` dans `routes.txt`, attendent exactement six caractères hexadécimaux (`0` à `9`, `A` à `F`, en majuscules ou en minuscules), sans dièse. `E2001A` et `e2001a` sont valides ; `#E2001A`, `F00`, `red` ou `E2001` ne le sont pas.

Sévérité : **erreur**.

## Pourquoi c'est important

Les applications de voyageurs et les cartes utilisent ces couleurs pour reconnaître une ligne. Une valeur mal formée est en général ignorée, et la ligne s'affiche avec une couleur par défaut, différente de celle des plans et des véhicules. Pour `route_text_color`, le texte peut devenir illisible sur le fond de la ligne.

## Causes fréquentes

- Le dièse recopié depuis une charte graphique ou une feuille de style (`#00A0E2`).
- Le format court à trois caractères (`F60`) ou un nom de couleur.
- Un tableur qui lit la valeur comme un nombre : `000000` devient `0`, `009900` devient `9900`.
- Une espace ou un caractère invisible en fin de valeur.

## Comment la corriger

Dans `routes.txt`, remplacez chaque valeur signalée par le code à six caractères de la couleur voulue : retirez le dièse, développez un format court (`F60` donne `FF6600`), convertissez un nom en code. Si la couleur n'est pas connue, laissez le champ vide : il est facultatif, et vide vaut blanc pour `route_color` et noir pour `route_text_color`. Vérifiez ensuite le contraste entre les deux couleurs, qui fait l'objet de l'avertissement [route_color_contrast](/regles/route_color_contrast).

Dans GTFS Express, le rapport de validation liste chaque ligne fautive avec sa valeur. « Corriger un par un » ouvre la ligne dans l'éditeur, le champ signalé ; la correction devient une retouche du brouillon, puis « Revalider » relance le contrôle.

## Exemple

```
route_id,route_short_name,route_type,route_color,route_text_color
L1,1,3,#E2001A,FFFFFF
L2,2,3,F60,000000
L3,3,3,0,FFFFFF
```

Corrigé :

```
route_id,route_short_name,route_type,route_color,route_text_color
L1,1,3,E2001A,FFFFFF
L2,2,3,FF6600,000000
L3,3,3,000000,FFFFFF
```

Voir aussi la [liste des règles de validation](/regles).
