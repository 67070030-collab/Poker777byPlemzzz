// Poker777 frontend runtime config.
//
// Where is the backend (REST + WebSocket)?
//   - Local dev  : leave EMPTY ("") — api.js falls back to <this-host>:4000.
//   - AWS ท่าที่ 1 : the frontend is served from S3 (a different host than the
//     backend), so set this to the ALB's public DNS, e.g.
//         window.POKER_API_BASE = "http://poker777-alb-123456789.us-east-1.elb.amazonaws.com";
//     (http, no trailing slash). api.js turns http→ws automatically for the socket.
window.POKER_API_BASE = "http://poker777-alb-1386745269.us-east-1.elb.amazonaws.com";
