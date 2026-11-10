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

## Première connexion

1. [Dashboard Spotify](https://developer.spotify.com/dashboard) → **Create app**

| Champ | Valeur |
|--------|--------|
| **App name** | `Spotify Light` |
| **App description** | `Lecteur perso` |
| **Website** | vide |
| **Redirect URIs** | `http://127.0.0.1:5173/callback` |
| **APIs / SDKs** | **Web API** + **Web Playback SDK** |
| **I understand…** | coche |

2. Settings → copie le **Client ID**
3. Dans l’app : colle → **Enregistrer** → **Connexion Spotify**  
   (ensuite c’est mémorisé)

---

## AirPlay / HomePod

Envoie le son de Spotify Light vers un HomePod (même Wi‑Fi). Capture WASAPI de la **sortie PC** sélectionnée dans l’app (menu engrenage) — comme HomeListen.

1. Choisis la sortie PC (casque / HDMI / défaut) si besoin  
2. Lance une piste  
3. Icône **AirPlay** → choisis le HomePod  
4. Volume HomePod + option **Garder aussi le son sur le PC**  
5. **Arrêter AirPlay** pour couper  

Si d’autres apps jouent sur **la même** sortie Windows, elles peuvent aussi partir sur le HomePod.  
Pare-feu Windows : autoriser au premier essai (réseau privé).

Licence stack AirPlay : **GPL-2.0** (`LICENSE`, `vendor/airplay2-rs`).
