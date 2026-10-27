# Neon Garden music

## Included playlist

`city-audio.js` contains three original instrumental compositions created for this game: **Rustaveli Afterhours** (boom bap, 92 BPM), **Peach Soda '96** (R&B, 104 BPM), and **Neon Express '99** (club, 124 BPM). Each has a 32-bar arrangement with an introduction, changing drums/bass/chords, a melodic section, a breakdown, and a closing section. Notes, drums and instrument timbres are synthesized by Web Audio. No commercial recording, vocal, downloaded song, external sample, or artist imitation is included. The original source follows the repository's ISC license.

The playlist uses a continuous clock. Moving changes gain, stereo position and distance filtering; it does not reload tracks. Outside the garden the mix fades out, then returning joins the current musical position. Muting, volume and music/effects preferences are saved on the current device. Audio is created/resumed only after a permitted user interaction, and a hidden page becomes quiet.

## Source investigation (27 October 2026)

An official YouTube embed is an option for a visible video experience, subject to the applicable terms and the availability of embedding for a particular video. It is unsuitable as an invisible speaker soundtrack: YouTube's policies prohibit separated audio and hidden/background playback. Its official player documentation also specifies a visible minimum player size. The game does not fetch, download, extract or restream YouTube content. Sources: [YouTube developer policies](https://developers.google.com/youtube/terms/developer-policies), [IFrame player requirements](https://developers.google.com/youtube/iframe_api_reference), [required minimum functionality](https://developers.google.com/youtube/terms/required-minimum-functionality).

Spotify's developer policy excludes games and synchronization with visual media. A Spotify subscription or developer integration therefore is not used to supply the garden's shared soundtrack. Sources: [Spotify developer policy](https://developer.spotify.com/policy), [Spotify compliance tips](https://developer.spotify.com/compliance-tips).

The browser's own autoplay rules still apply to original or licensed audio. Defaults are ON, but playback waits for the first permitted pointer or keyboard interaction. The game neither bypasses the restriction nor repeatedly prompts players. Source: [Chrome Web Audio autoplay guidance](https://developer.chrome.com/blog/web-audio-autoplay).

## Adding authorized recordings later

Call `GaicaniCityAudio.configureTracks()` before playback with audio URLs you are authorized to use in this game and deployment. Both the sound recording and composition rights must cover the intended use. Supply credits, rights/license information, duration and BPM. Self-hosted assets are simplest; remote HTTPS audio must be served with CORS permission for Web Audio routing. Platform web-page URLs are not audio assets and are rejected.

```js
GaicaniCityAudio.configureTracks([
  {
    id: "authorized-track",
    kind: "audio",
    title: "Your authorized recording",
    url: "/audio/authorized-recording.ogg",
    duration: 192,
    bpm: 96,
    credit: "Artist and composition credits supplied by the rights holder",
    license: "The license or permission covering this game's use"
  }
]);
```

This configuration uses the same continuous playlist clock, spatial routing, saved preferences, fades and controls as the original music. Do not insert a commercial recording until the deployment has the necessary permissions. Keep a copy of the authorization with the asset's release records.
