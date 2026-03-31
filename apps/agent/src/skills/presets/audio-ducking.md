---
skill_id: skill_preset_audio_ducking
skill_status: validated
agent_type: audio
applies_to: ["mixing", "ducking", "voice-over"]
---

# Audio Ducking

## Rules
- Duck background music by -12dB when voice-over is detected
- Apply 200ms attack and 500ms release on ducking envelope
- Maintain music presence at -18dB under dialogue (never fully mute)
- Restore music to full level within 1 second of voice-over ending
- Use sidechain compression for dynamic ducking on music-heavy segments
