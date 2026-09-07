# Organiseur BD — publication et synchronisation

## 1. Préparer Supabase

1. Ouvrez votre projet Supabase puis **SQL Editor**.
2. Copiez-collez tout `supabase-setup.sql` et cliquez sur **Run**. Le script est réexécutable sans créer de doublons.
3. Dans **Authentication > URL Configuration**, ajoutez l'URL locale de test `http://127.0.0.1:8767` dans **Redirect URLs**.

## 2. Tester en local

L'app doit être ouverte depuis `http://127.0.0.1:8767`, jamais avec une adresse `file:///`. Entrez votre e-mail, cliquez sur Connexion, puis cliquez sur le lien magique reçu. Ajoutez une tâche et une note : les deux doivent apparaître dans Supabase, respectivement dans les tables `todos` et `notes`.

## 3. Publier avec GitHub Pages

1. Créez un dépôt GitHub public, par exemple `organiseur-bd`.
2. Téléversez **le contenu** de ce dossier à la racine du dépôt : `index.html`, `app.js`, `supabase-config.js`, `supabase-setup.sql` et ce README.
3. Faites un commit, puis ouvrez **Settings > Pages**.
4. Choisissez **Deploy from a branch**, sélectionnez `main`, puis enregistrez. GitHub affichera une adresse semblable à `https://VOTRE-NOM.github.io/organiseur-bd/`.
5. Dans Supabase **Authentication > URL Configuration**, mettez cette URL dans **Site URL** et ajoutez-la aussi dans **Redirect URLs**. Laissez l'URL locale si vous souhaitez continuer les tests PC.
6. Ouvrez l'URL GitHub Pages sur chaque appareil et connectez-vous avec la même adresse e-mail.

## Vérifications

- Une nouvelle tâche / note est sauvegardée automatiquement.
- Une modification depuis un appareil apparaît sur l'autre sans rechargement grâce à Realtime.
- Hors ligne, les changements restent dans IndexedDB et sont envoyés lorsque la connexion revient.
- N'ajoutez jamais une clé `service_role` dans `supabase-config.js`.
