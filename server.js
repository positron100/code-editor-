const express = require("express");
const app = express();
const http = require("http");
const ACTIONS = require("./src/Actions");
const { Server } = require("socket.io");
const path = require("path");
const server = http.createServer(app);

// app.use(express.static("build"));
// all the request are now beign served index.html
// app.use((req, res, next) => {
//   res.sendFile(path.join(__dirname, "build", "index.html"));
// });
// storing it in the memory , can be stored in DataBase for production level app
// whenever someone joins then a new entry mapping socketId to user will be added
const userSocketMap = {};

function getAllConnectedClients(roomId) {
  // io.sockets.adapter.rooms.get(roomId) : fetch all rooms with the mentioned roomId in socket server
  return Array.from(io.sockets.adapter.rooms.get(roomId) || []).map(
    // each user have a unique socketid
    (socketId) => {
      return {
        socketId,
        username: userSocketMap[socketId],
      };
    }
  );
}

const io = new Server(server);
io.on("connection", (socket) => {
  // latest joined user socketId will be id for the room
  console.log("socket connected", socket.id);
  // listening the emitted JOIN event
  socket.on(ACTIONS.JOIN, ({ roomId, username }) => {
    userSocketMap[socket.id] = username;
    // socket will be joined into the provided room {roomId}
    socket.join(roomId);
    // notification when the user is joinng the room
    // list of all the clients in the room
    const clients = getAllConnectedClients(roomId);
    console.log(clients);
    clients.forEach(({ socketId }) => {
      // emitting the message to room / have to be listened on frontend
      io.to(socketId).emit(ACTIONS.JOINED, {
        clients,
        username,
        socketId: socket.id,
      });
    });
  });

  //  ******************** flow ********************
  // Realtime updation of code through web socket
  // typing the code in editor -->
  // event is being emitted to server -->
  // alongside with code and roomId-->
  // sending the code to all the clients in the room

  // emitting the changed code
  // listening to emitted CODE_CHANGE event from client
  socket.on(ACTIONS.CODE_CHANGE, ({ roomId, code }) => {
    // emitting the code to whole room
    // using socket.in instead of io.to because the event should not be listened by the typing user
    socket.in(roomId).emit(ACTIONS.CODE_CHANGE, {
      code,
    });
  });
  // listening the event for SYNC_CODE
  socket.on(ACTIONS.SYNC_CODE, ({ socketId, code }) => {
    io.to(socketId).emit(ACTIONS.CODE_CHANGE, {
      code,
    });
  });

  // when a client want to leave room
  socket.on("disconnecting", () => {
    // fetch all the rooms the client is in
    const rooms = [...socket.rooms];
    // broadcast the message to all the users
    rooms.forEach((roomId) => {
      socket.in(roomId).emit(ACTIONS.DISCONNECTED, {
        socketId: socket.id,
        username: userSocketMap[socket.id],
      });
    });

    // deleting the user
    delete userSocketMap[socket.id];
    socket.leave();
  });
});

const PORT = process.env.PORT || 5000;
server.listen(PORT, () => {
  console.log(`listening in http://localhost:${PORT}/`);
});
