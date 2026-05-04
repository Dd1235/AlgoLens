# 🎯 PROBLEM YOU WANT TO SOLVE

## 1. Baseline Need

- You want a system that can **search DSA problems effectively**
- Given a query (keywords or problem), it should return **relevant problems**
- This includes:
  - keyword-based retrieval
  - ranking using standard IR ideas (e.g., TF-IDF, BM25)

- So the first goal is definitely to make a problem search engine. compare these methods. first do in nodejs, then try for a cpp microservices with grpc.

### Why this matters

- Provides a **minimum viable, demonstrable system**
- Covers expected backend/system design concepts
- Ensures you have a **working project even if advanced ideas fail**

---

## 2. Core Pain Point (real motivation)

- Existing platforms rely on:
  - tags (too broad)
  - problem statements (misleading)

- But:
  - two problems with similar wording may require completely different solutions
  - two problems with completely different wording may require the **same idea**

### Example pain

- You solve a problem using:
  - bottom-up DP with a specific transition

- You want:
  - problems that reinforce **that exact thinking pattern**

- You do NOT want:
  - all DP problems
  - all problems with similar wording

---

## 3. True Objective (beyond search)

- Build a system that can identify and retrieve problems based on:
  - **similarity of solution thinking**
  - **similarity of underlying patterns**

- Not just:
  - text similarity
  - tags

### Why this matters

- DSA learning is fundamentally about:
  - recognizing patterns
  - reusing mental models

- Current tools do not support this well

---

## 4. Nature of the Challenge

- The “meaning” of a DSA problem is:
  - not explicit in text
  - not captured by tags

- It is hidden in:
  - constraints
  - transitions
  - structural decisions

### Implication

- Standard search paradigms are insufficient
- This is closer to:
  - pattern discovery
  - reasoning similarity
  - latent structure matching

---

## 5. Desired Behavior of the System

### Given a problem:

- Return problems that:
  - feel similar **after solving them**
  - share underlying approach
  - reinforce the same idea

### Not required:

- identical wording
- same tags
- same story/context

---

## 6. Secondary Objective (learning-focused)

- Extend beyond retrieval into **learning support**

System should help:

- reinforce concepts
- expose variations of the same idea
- guide progression in difficulty
- revisit previously solved problems over time

### Why this matters

- Practicing DSA is not just solving new problems
- It is:
  - revisiting patterns
  - strengthening recall
  - recognizing transformations of ideas

---

## 7. Personalization Aspect

- The system should adapt based on:
  - what the user has solved
  - how recently they solved it
  - frequency of exposure

### Goal

- Move from:
  - generic recommendations

- To:
  - **user-specific learning paths**

---

## 8. Broader Framing

This problem sits at the intersection of:

- information retrieval (search)
- recommendation systems
- learning systems

---

## 9. Key Tension (important to acknowledge)

- You need:
  - a **working baseline system** (for reliability, resume)

- You want:
  - a **deeper system capturing solution-level similarity**

These are:

- not the same problem
- but must coexist in the same project

---

## 10. Success Criteria

The system is valuable if:

- For search:
  - returns reasonable results for keyword queries

- For similarity:
  - connects problems that “feel the same” when solved

- For learning:
  - helps reinforce and revisit patterns

- For demonstration:
  - shows measurable improvement over simple keyword search

---

## 🧠 One-line summary

> Build a system that starts as a standard DSA search engine but aims to evolve into one that retrieves problems based on **similarity of underlying solution patterns**, supporting more effective learning than tag-based or text-based approaches.

---
