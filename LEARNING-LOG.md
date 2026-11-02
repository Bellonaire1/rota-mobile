# Rota — Student Graduation Learning Log

> **INSTRUCTIONS FOR STUDENT:**<br>
> This document is your personal technical reflection for the Dev and Design HQ Product Design and Engineering Bootcamp final graduation task.<br>
> **Please replace all bracketed placeholders (e.g. `[Your Name]`, `[Your Reflections]`) with your own honest, authentic words.**<br>
> Evaluators look for genuine technical reflections on challenges faced, architectural trade-offs made, and lessons learned. Do not copy-paste generic text.

---

## 1. Student & Project Identification

- **Student Name:** `[Your Full Name]`
- **Cohort / Program:** `[e.g., Dev and Design HQ — Product Design & Engineering Bootcamp]`
- **Project Title:** Rota — Team Shift-Scheduling Mobile Application
- **GitHub Repository:** [https://github.com/Bellonaire1/rota-mobile](https://github.com/Bellonaire1/rota-mobile)
- **Live Backend URL:** [https://rota-api-demo.vercel.app/api/v1/health](https://rota-api-demo.vercel.app/api/v1/health)
- **Android APK Build URL:** [https://expo.dev/accounts/bellonaire/projects/rota-mobile/builds/222cb397-2fdb-4286-9b49-009c59a470a8](https://expo.dev/accounts/bellonaire/projects/rota-mobile/builds/222cb397-2fdb-4286-9b49-009c59a470a8)
- **Date of Submission:** `[e.g., November 2026]`

---

## 2. Technical Journey & Significant Challenges Overcome

*Describe 2–4 of the hardest technical problems you encountered during this project and how you solved them.*

### Challenge 1: Transitioning Backend to Vercel Serverless & Engine Compatibility
- **The Problem:** `[Describe what happened when deploying to Vercel: e.g., Prisma query engine errors on Linux serverless environments, Vercel Node 20 deprecation, or root directory configuration.]`
- **My Solution:** `[Explain how you resolved this: e.g., adding binaryTargets = ["native", "rhel-openssl-3.0.x"] to Prisma schema, pinning Node.js 22 in engines.node, reconciling package-lock.json with prisma as a production dependency, and utilizing Vercel's zero-config Express preset.]`
- **What I Learned:** `[What did this teach you about serverless runtimes vs long-running servers?]`

### Challenge 2: Dual-Token Authentication & Replay Prevention
- **The Problem:** `[Describe the challenge of managing mobile authentication: e.g., token expiration, race conditions with multiple parallel network requests, or securing credentials on the device.]`
- **My Solution:** `[Explain your approach: e.g., 15-minute access JWTs in memory, rotating opaque refresh tokens in Expo SecureStore, in-flight promise deduplication in apiClient.ts, and server-side token family invalidation.]`
- **What I Learned:** `[What did you learn about security in mobile applications?]`

### Challenge 3: Password Visibility Toggle & Mobile Accessibility
- **The Problem:** `[Describe building the password toggle in React Native: e.g., lack of pre-installed icon libraries, maintaining 44x44 touch targets, and avoiding layout shifts.]`
- **My Solution:** `[Explain how you built a zero-dependency vector EyeIcon with pure React Native Views, integrated it into FormField, and handled screen-reader labels and auto-capitalization.]`
- **What I Learned:** `[What did you learn about mobile UX, accessibility, and component reusability?]`

---

## 3. Key Architecture & Design Decisions

*Explain why you structured the application the way you did and the trade-offs you considered.*

### Decision 1: Scoping Permissions to Team Memberships (`TeamRole`)
- **Reasoning:** `[Why is TeamRole on TeamMembership instead of User? Explain how this supports multi-tenant work where a user is an Owner of one team and a Staff member of another.]`
- **Trade-Offs:** `[What complexity did this introduce into queries and middleware?]`

### Decision 2: Enforcing `DEMO_MODE=true` as a Fail-Closed Safety Boundary
- **Reasoning:** `[Why did you disable live Paystack checkout and webhooks in the demo deployment? Explain the importance of fail-closed financial safety when code is incomplete or experimental.]`
- **Trade-Offs:** `[How does this protect the demo environment while still demonstrating tested backend reconciliation code?]`

### Decision 3: Single-Instance Database vs. Premature Sharding
- **Reasoning:** `[Why did you choose a single Neon PostgreSQL instance with composite indexes rather than prematurely implementing physical sharding?]`
- **Trade-Offs:** `[What are the limits of this approach, and when would you migrate to Phase 2 of SHARDING.md?]`

---

## 4. Incomplete Work & Future Roadmap

*Be completely transparent about what is not yet built and why.*

1. **Live Payment Gateway Activation:**
   `[Explain why payments remain in DEMO_MODE, what remains to connect live Paystack keys, and what is stored in the protected Git stash.]`
2. **Push Notifications:**
   `[Describe what would be needed to add Expo Push Notifications / FCM for shift reminder dispatches.]`
3. **Background Worker & Distributed Queue:**
   `[Describe the plan for Redis and BullMQ to handle webhook event queues off the serverless critical path.]`
4. **Load Testing:**
   `[Describe what k6 tests you would run to benchmark the API under high concurrent traffic.]`

---

## 5. Personal Reflection & Bootcamp Conclusion

*Write a candid personal reflection on your growth as an engineer during this project.*

- **My Biggest Growth Area:**
  `[Reflect on where you grew the most: e.g., TypeScript strictness, understanding relational data models, mobile debugging, or production deployment readiness.]`

- **What I Would Do Differently Next Time:**
  `[Reflect on any early mistakes or things you would design differently from day one.]`

- **Final Summary:**
  `[A concluding statement on what successfully building, deploying, and testing this full-stack mobile system means to you.]`

---

**Student Signature:** `[Type Your Name]`
**Date:** `[DD/MM/YYYY]`
