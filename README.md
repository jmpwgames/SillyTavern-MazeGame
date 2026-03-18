# SillyTavern MazeGame

A simple maze game built for SillyTavern where you and your AI share control of the same character.

This isn’t meant to be a traditional game. It’s a way to give your AI something real to interact with — not just text, but an actual environment with state, decisions, and consequences.

---

## What this is

MazeGame is basically a testbed for AI-controlled gameplay.

You move around a maze. Your AI can also move around the maze. You can let it take control, step in when it messes up, or just watch what it decides to do.

The important part is that everything runs at a pace that works for LLMs instead of against them.

---

## ⚠️ Important: Check the Extension Drawer Settings

Before you do anything else, **open the SillyTavern extension drawer and look through the MazeGame options**.

A lot of how this extension behaves is controlled from there:
- control modes  
- polling behavior  
- how input is handled  
- how much control the AI has  

If something feels off or “not working,” it’s almost always because of a setting in the extension UI.

Don’t skip this. Take a minute and actually read through the options — it will save you a lot of confusion.

---

## How it works

Instead of real-time controls, the game runs in a loop:

1. The current game state is shown to the AI  
2. The AI decides what to do  
3. That input gets applied  
4. Repeat every ~10–20 seconds  

That delay is intentional. It gives the AI time to actually think instead of just reacting blindly.

---

## Why this exists

Most games are terrible for AI control:
- too fast  
- too timing-dependent  
- too noisy  

This strips things down to something an LLM can actually handle:
- clear choices  
- simple movement  
- consistent rules  

It turns gameplay into something closer to a conversation with consequences.

---

## Features

- **Shared control**  
  You and your AI both control the same character. You can override it anytime.

- **LLM-friendly design**  
  Slow update loop, simple inputs, and predictable state.

- **SillyTavern integration**  
  Built to plug into SillyTavern workflows and extensions.

- **Experimentation-focused**  
  This is more about testing AI behavior than making a polished game.

---

## What you can do with it

- Let your AI play a game with you  
- Give your AI full control and see how it behaves  
- Test decision-making and consistency  
- Use it as a base for more complex AI-controlled systems  

---

## Design philosophy

This project leans hard into a few ideas:

- Slower is better  
- Simple systems > complex mechanics  
- Shared control is more interesting than full automation  
- The AI is the focus, not the game  

---

## Requirements

- SillyTavern  
- An LLM capable of basic reasoning  
- Optional: any tooling you’re using to pipe game state in/out  

---

## Notes

This is intentionally minimal. The maze isn’t the point — the interaction is.

If something feels “too simple,” that’s probably on purpose.

---

## License

Apache License 2.0
