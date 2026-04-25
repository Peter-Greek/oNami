# oNami

oNami is a desktop flashcard app for studying imported Anki decks and your own custom cards in a cleaner, more focused interface.

It is built for people who want to:

- import `.apkg` decks and start studying quickly
- review cards with spaced repetition scheduling
- track streaks, time spent studying, and deck progress
- create their own cards without leaving the app
- keep everything stored locally on their computer

## What oNami Does

oNami is centered around a few core jobs:

### Import Anki decks

You can bring in standard Anki `.apkg` files, including nested decks and media.

### Study with spaced repetition

Cards are scheduled with a modern review system so the app can keep bringing back the right cards at the right time.

### Show clear progress

You can see:

- your daily streak
- time studied today, this week, this month, and overall
- deck completion progress
- recall performance
- harder cards that may need extra attention

### Let you build cards directly in the app

You can:

- create basic front/back cards
- create cloze cards
- batch paste multiple cards at once
- generate draft cards with AI if you add an OpenAI API key in Settings

### Reset scheduling when needed

Each deck has a reset button that can restore scheduling back to its original imported state when that baseline exists. This is useful for testing, restarting a deck, or cleaning up a schedule that no longer feels right.

## Getting Started

The easiest way to use oNami is through a release build of the desktop app.

1. Download the latest installer from the repository Releases page.
2. Install and open oNami.
3. Import a deck or create one from scratch.
4. Start studying.

If you are just here to use the app, you do not need to know anything about Node, Electron, or the source code.

## Importing an Anki Deck

oNami imports `.apkg` files.

To import:

1. Open the **Import** tab.
2. Click **Choose .apkg**.
3. Pick your Anki export file.
4. Decide whether to preserve Anki scheduling:
   - **On**: keep imported review state when available
   - **Off**: bring the cards in as a fresh start
5. Click **Import deck**.

After import, the deck will appear in the Study view.

## How to Study

The **Study** tab is where you spend most of your time.

### Pick a deck

Use the deck list to choose the deck or subdeck you want to work on.

The deck list shows:

- new cards
- due cards
- total cards
- completion state for fully learned decks

### Choose a study mode

oNami supports four study modes:

- **Learn new**: focus on unseen cards
- **Review due**: review cards that are ready now
- **Mixed**: combine due cards with new cards
- **Unit test**: a focused pass on weaker cards

### Review a card

1. Start a session.
2. Read the front of the card.
3. Click **Reveal**.
4. Grade yourself:
   - **Again**
   - **Hard**
   - **Good**
   - **Easy**

oNami uses that rating to update scheduling for the next review.

## Creating Your Own Cards

Use the **Create** tab if you want to build your own material.

You can:

- create a new deck
- add a single basic card
- add a cloze card
- paste multiple cards in a batch
- generate AI card drafts from notes or source material

If you want to use AI generation:

1. Open **Settings**
2. Add your OpenAI API key
3. Choose the model you want to use
4. Return to **Create** and generate drafts

AI is optional. The app works fine without it.

## Stats and Progress

The **Stats** tab is meant to answer simple questions quickly:

- How much have I studied today?
- Am I keeping a streak going?
- Which decks are moving forward?
- Which cards are giving me trouble?

You can also narrow stats down to a specific deck, which is helpful if you study different subjects with very different workloads.

## Deck Controls

In the deck list, each deck or subdeck has a few direct controls:

- **Select the deck** by clicking its row
- **Reset scheduling** with the refresh button
- **Delete the deck** with the trash button

Resetting scheduling does **not** wipe your overall streak or time-studied totals. It is meant to reset the card schedule and card-level analytics, not erase your overall study history.

## Settings

In **Settings**, you can:

- adjust audio volume
- set your theme
- add or update your OpenAI API key
- choose the AI model for draft generation

## Your Data

oNami stores your decks, review history, and settings locally on your computer.

That means:

- your cards stay available offline
- your study history is kept in the app locally
- AI features only use OpenAI if you choose to add an API key

## Who oNami Is For

oNami is a good fit if you want:

- a desktop-first flashcard workflow
- Anki deck import without living inside Anki full-time
- a cleaner study interface
- built-in progress tracking
- easy deck resets for testing or restarting

## Quick Start Summary

If you want the short version:

1. Install oNami
2. Import an `.apkg` deck
3. Open **Study**
4. Pick a deck
5. Start a session
6. Review with **Again / Hard / Good / Easy**
7. Check **Stats** to see your progress

That is the core loop.
