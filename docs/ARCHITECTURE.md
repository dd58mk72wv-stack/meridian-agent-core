# Architecture

## The shape

```
                    trigger (call · sms · email · scheduled · system)
                                      |
                                    [ CMO ]        interprets, dispatches, and is the
                                      |            only place that sees a request touching
                    +-----------------+----+       two departments at once
                    |                      |
              [ Manager ]            [ Manager ]   routes to an agent, reports back up
                    |                      |       never executes the work itself
            +-------+------+         +-----+-----+
          [Agent]        [Agent]   [Agent]     [Agent]    one job each
```

Everything below the CMO receives the **whole** context, not a task extracted from it. That
is what lets the second half of a two-part request land with the first half already known.

## Why the context object is shaped the way it is

The three-tier rule erodes through reasonable tidy-ups, never through decisions. Someone
writes a manager that passes `{ caller, intent }` instead of the whole thing, because that is
all its agent appears to need — and six months later the escalation path has no idea the
caller already said they were in a hurry.

So `Context` has no setter, no truncate, no summarise, and `notes()` returns a copy. A
revised fact keeps the original alongside it rather than overwriting. Changing that requires
editing `context.ts`, which is the point.

## Why the voice chain is one component

Twenty-one agents each owning their own copy of "how a phone call works" is twenty-one places
to fix a dropped call. Vapi handles the microphone, the turn-taking and the speech; from here
the chain is a single HTTP handler.

**A correction to the vertical build prompts:** they describe ElevenLabs as the
"Fable 5.1 voice/personality layer". That conflates two things. ElevenLabs is text-to-speech
— how the words sound. Claude Fable 5.1 is a language model — what the words are. The
personality is in the agent's prompt. ElevenLabs is configured inside Vapi and has no key in
this system, so nobody should go looking for one.

## Why adapters are small and declare capabilities

A dealership's DMS has stock and no treatment plans; a dental PMS has the reverse. One
combined interface forces every adapter to implement methods that make no sense for it and
then throw — pushing the failure to runtime, on a call.

Capabilities are declared up front because read-only practice management systems are common,
and an agent that discovers this halfway through booking has already told a caller the
appointment is made.

## Payments

No agent ever handles a card number. `PaymentAdapter` can create a payment *link* and read a
status, and deliberately exposes nothing that takes a card — a voice agent reading back a PAN
is a PCI problem that no amount of care makes acceptable, and the call is being recorded.
