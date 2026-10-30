# Spotify Light

Le **strict minimum** de Spotify pour Windows : likes, recherche, lecture, volume, sortie audio. Rien d’autre.

- **CPU** : proche de **0 %** en lecture
- **RAM** : environ **÷ 4** vs Spotify desktop

**Premium** requis.

---

## Télécharger

- **Projet (zip)** : [Download ZIP](https://github.com/goatmsiuser13199/spotify-light-for-stream/archive/refs/heads/main.zip)
- **Installateur** : [`Spotify-Light-Setup.exe`](./Spotify-Light-Setup.exe) (à la racine)

---

## Installer

1. Lance **`Spotify-Light-Setup.exe`** → Suivant → sans admin → raccourci Bureau
2. [Dashboard Spotify](https://developer.spotify.com/dashboard) → **Create app**

| Champ | Valeur |
|--------|--------|
| **App name** | `Spotify Light` |
| **App description** | `Lecteur perso` |
| **Website** | vide |
| **Redirect URIs** | `http://127.0.0.1:5173/callback` |
| **APIs / SDKs** | **Web API** + **Web Playback SDK** |
| **I understand…** | coche |

3. Settings → copie le **Client ID**
4. Dans l’app (1ʳᵉ fois) : colle → **Enregistrer** → **Connexion Spotify**  
   (ensuite c’est mémorisé)
