import React, { useState } from "react";
import { v4 as uuidv4 } from "uuid";
import toast from "react-hot-toast";
import { useNavigate } from "react-router-dom";
const Home = () => {
  const navigate = useNavigate();

  const [roomId, setRoomId] = useState("");
  const [username, setUsername] = useState("");
  const createNewRoom = (e) => {
    // To stop Reloading page everytime
    e.preventDefault();
    const id = uuidv4();
    setRoomId(id);
    // Display modal only when calling this function
    toast.success("New Room Created");
  };
  const joinRoom = () => {
    if (!roomId || !username) {
      toast.error("id and username required");
      return;
    }
    //redirect
    navigate(`/editor/${roomId}`, {
      state: {
        // can access username on navigated page
        username,
      },
    });
  };
  // navigate to edtor page on pressing Enter key
  const handleInputEnter = (e) => {
    if (e.code === "Enter") {
      joinRoom();
    }
  };
  return (
    <div className="homePageWrapper">
      <div className="formWrapper">
        <img
          className="homePagelogo"
          src="/code-sync.png"
          alt="code-sync-logo"
        />
        <h4 className="mainLabel">Paste invitation ROOM ID</h4>
        <div className="inputGroup">
          <input
            type="text"
            className="inputBox"
            placeholder="ROOM ID"
            onChange={(e) => setRoomId(e.target.value)}
            onKeyUp={handleInputEnter}
            value={roomId}
            name="roomid"
          />
          <input
            type="text"
            className="inputBox"
            placeholder="USERNAME"
            onChange={(e) => setUsername(e.target.value)}
            onKeyUp={handleInputEnter}
            value={username}
            name="user"
          />
          <button className="btn joinBtn" onClick={joinRoom}>
            Join
          </button>
          <span className="createInfo">
            If you don't have an invite then create &nbsp;
            <button onClick={createNewRoom}  className="createNewBtn">
              new room
            </button>
          </span>
        </div>
      </div>
      <footer>
        <h4>
          Built by <a href="https://github.com/positron100">Mukul</a>
        </h4>
      </footer>
    </div>
  );
};

export default Home;
