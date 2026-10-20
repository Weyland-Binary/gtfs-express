# Kit de préproduction (staging)

Ce kit lance une copie de GTFS Express **à côté** de la production, sur le même serveur, sans jamais la toucher. Il sert à essayer la branche `further` avec les comptes et le Studio Projet réseau activés avant toute mise en production.

## Ce que le kit ne touche jamais

- Les conteneurs de production (`gtfs-api`, `gtfs-frontend`, `gtfs-caddy`, `gtfs-goaccess`).
- Les volumes de production (`uploads_data`, `projects_data`, `shares_data`, `caddy_*`, `goaccess_html`) et leur réseau.
- Le fichier `.env` de production, Caddy, les certificats, les tâches cron.
- Aucune commande `docker system prune`, `docker image prune` ou `docker volume prune`.

Tout ce que le kit crée porte le préfixe `gtfs-staging` : conteneurs `gtfs-staging-api` et `gtfs-staging-frontend`, volumes `gtfs-staging_staging_uploads`, `gtfs-staging_staging_projects`, `gtfs-staging_staging_shares` (les liens de partage) et `gtfs-staging_staging_beta` (le journal d'usage de l'IA), réseau `gtfs-staging_staging`. Le site n'écoute que sur `127.0.0.1:18080` : rien n'est exposé sur internet.

## Étapes

Chaque commande ci-dessous est à lancer par vous, sur le serveur, une par une.

1. Cloner la branche `further` dans un dossier séparé de la production.

   La branche `further` vit dans le dépôt privé `Weyland-Binary/gtfsexpress-lab` ; la production suit toujours `main` du dépôt public, sans changement. Le serveur lit le dépôt privé avec une clé de déploiement à lui, en lecture seule. D'abord la créer et l'afficher :

   ```sh
   ssh-keygen -t ed25519 -N "" -C "gtfs-staging, lecture seule" -f ~/.ssh/gtfsexpress_lab
   cat ~/.ssh/gtfsexpress_lab.pub
   ```

   Sur GitHub, dans le dépôt privé : Settings → Deploy keys → Add deploy key, coller la ligne affichée, laisser « Allow write access » décoché. Puis cloner :

   ```sh
   GIT_SSH_COMMAND="ssh -i ~/.ssh/gtfsexpress_lab -o IdentitiesOnly=yes" git clone --branch further --single-branch git@github.com:Weyland-Binary/gtfsexpress-lab.git /opt/gtfs-staging
   cd /opt/gtfs-staging
   git config core.sshCommand "ssh -i ~/.ssh/gtfsexpress_lab -o IdentitiesOnly=yes"
   mkdir -p GTFS-EXPRESS-API/beta
   ```

   À la première connexion, ssh demande de confirmer l'empreinte de `github.com` : comparez-la avec celles que GitHub publie (« GitHub's SSH key fingerprints » sur docs.github.com) avant de répondre `yes`. La ligne `git config` fait servir la même clé aux `git pull` de ce dossier, et à lui seul.

   Le dossier `GTFS-EXPRESS-API/beta` n'est pas dans git, mais la construction de l'image le copie : sans lui, l'étape 4 échoue. Il reste vide dans l'image (`.dockerignore` en écarte les fichiers).

2. Créer le fichier d'environnement de préproduction à partir du modèle, puis y mettre trois secrets neufs.

   ```sh
   cp deploy/staging/.env.staging.example deploy/staging/.env.staging
   openssl rand -hex 32   # à coller dans ADMIN_TOKEN
   openssl rand -hex 32   # à coller dans IP_HASH_SECRET
   openssl rand -hex 32   # à coller dans CLIENT_TOKEN_SECRET (ligne à ajouter)
   nano deploy/staging/.env.staging
   ```

   Sans `CLIENT_TOKEN_SECRET`, les projets ne sont pas conservés sur le serveur (ils restent dans le navigateur). Ne le changez jamais en même temps que les deux autres : chaque projet sans compte serait perdu.

   Mettez aussi votre propre adresse e-mail dans `ADMIN_EMAILS` : une fois vérifiée par un code de connexion, elle a tous les droits, sans fin (voir « Connexion et licence » plus bas).

   L'IA reste coupée par défaut. Pour l'essayer, mettez `NL2SQL_CHAT_ENABLED=true` et une clé Anthropic, de préférence une clé distincte avec son propre plafond de dépenses.

3. Lancer les vérifications, qui ne modifient rien : dossier, secrets, disque libre (6 Go au moins), mémoire disponible (1,5 Go au moins), port libre, noms libres. La liste des conteneurs de production s'affiche en lecture seule.

   ```sh
   sh deploy/staging/preflight.sh
   ```

4. Construire et démarrer la préproduction. Le script relance les vérifications et s'arrête si l'une échoue.

   ```sh
   sh deploy/staging/up.sh
   ```

5. Depuis votre ordinateur, ouvrir un tunnel SSH, puis le site dans le navigateur.

   ```sh
   ssh -L 18080:127.0.0.1:18080 deploy@137.74.12.64
   ```

   Adresse : http://127.0.0.1:18080

6. Vous connecter sur le site : menu « Se connecter », l'adresse mise dans `ADMIN_EMAILS`, puis le code à six chiffres. La préproduction n'envoie pas d'e-mail : le code s'écrit dans le journal de l'API, sur le serveur.

   ```sh
   docker logs gtfs-staging-api 2>&1 | grep '\[mail\]' | tail -n 1
   ```

   La ligne affichée porte le code dans son objet (« Votre code de connexion GTFS Express : … »). C'est le journal que montre aussi `docker compose logs api` lancé sur le projet `gtfs-staging`. Le premier code vérifié crée le compte ; avec votre adresse dans `ADMIN_EMAILS`, il a tous les droits.

   Pour donner une licence à un testeur, une fois qu'il s'est connecté (son code se lit de la même façon) : lister les comptes, puis lui accorder les droits jusqu'à une date (`AAAA-MM-JJ`, la licence achetée sur devis). Remplacez `SON_ID` par l'identifiant du compte, lisible dans la liste.

   ```sh
   TOKEN=$(grep '^ADMIN_TOKEN=' deploy/staging/.env.staging | cut -d= -f2)
   docker exec gtfs-staging-api wget -qO- --header="X-Admin-Token: $TOKEN" http://localhost:3004/gtfs/admin/users
   docker exec gtfs-staging-api wget -qO- --header="X-Admin-Token: $TOKEN" --header="Content-Type: application/json" --post-data='{"edit":true,"studio":true,"until":"2026-12-31"}' http://localhost:3004/gtfs/admin/users/SON_ID/entitlements
   ```

   `"until": null` : sans date de fin ; `{"edit":false,"studio":false}` : retirer la licence.

7. Essayer le parcours : charger un GTFS dans l'application, puis menu du compte, « Projets ».

8. Arrêter la préproduction. Les données de préproduction sont gardées, sauf si vous ajoutez `--volumes`.

   ```sh
   sh deploy/staging/down.sh            # arrête, garde les données de préproduction
   sh deploy/staging/down.sh --volumes  # arrête et efface les données de préproduction seulement
   ```

## Connexion et licence

Les codes d'accès bêta sont retirés : il n'y a plus de fichier de codes à copier. La préproduction fait tourner l'offre payante (`PAID_ACCESS_ENABLED=true` par défaut) : la lecture reste libre, toute modification demande un compte dont la licence court. La connexion est un code à six chiffres envoyé par e-mail ; ici, `MAIL_PROVIDER=log` l'écrit dans le journal de l'API au lieu de l'envoyer (étape 6).

- **Vous** : votre adresse dans `ADMIN_EMAILS` de `deploy/staging/.env.staging` (plusieurs adresses : séparées par des virgules), puis `sh deploy/staging/up.sh`. Une fois l'adresse vérifiée par un code, tous les droits, sans fin.
- **Un testeur** : il se connecte une fois, ce qui crée son compte. Il peut lancer lui-même l'essai gratuit (14 jours, `TRIAL_DAYS`, une fois par adresse), ou vous lui accordez une licence jusqu'à une date avec la route d'administration (étape 6).
- **De vrais e-mails** : `MAIL_PROVIDER=brevo`, avec `MAIL_API_KEY` et `MAIL_FROM` (une adresse d'expédition vérifiée chez Brevo), dans `deploy/staging/.env.staging`. La clé n'y figure que sur le serveur, jamais dans le dépôt.

Le prix annuel affiché (`LICENCE_PRICE_EUR_YEAR`, 4900 € HT par défaut) est indicatif : un paiement en ligne facture le prix du fournisseur de paiement, qui doit lui correspondre.

## En cas de doute

- `docker ps` doit toujours montrer les conteneurs de production en bon état, avant comme après.
- Pour tout effacer côté préproduction : `sh deploy/staging/down.sh --volumes`, puis supprimer le dossier `/opt/gtfs-staging`. Les images construites portent le préfixe `gtfs-staging` ; vous pouvez les supprimer une par une avec `docker image rm`, jamais avec une commande `prune`.
