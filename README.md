Here's the complete draft for your README file based on the structure and content you provided.

---

# Cloud Editor

Cloud Editor is a real-time collaborative code editor built using the MERN stack and WebSocket technology (Socket.io). It allows multiple users to collaborate on code in real-time within shared rooms.

## Features
- **Real-time code collaboration** using WebSocket.
- **Code Editor** with syntax highlighting and autocompletion powered by Codemirror.
- **User Rooms**: Create or join rooms with a unique Room ID to collaborate with other users.
- **Live Notifications**: Instant feedback through toast notifications.
- **Simple UI**: Responsive and user-friendly interface.

## Project Structure

```
src
├── components
│   ├── Client.js          # Handles client-side user display logic
│   ├── Editor.js          # Initializes Codemirror and syncs code changes
├── pages
│   ├── EditorPage.js      # Main page for the code editor, handles socket events
│   ├── Home.js            # Landing page for creating and joining rooms
├── Actions.js             # Contains socket event constants
├── App.js                 # Main application component
├── App.css                # Global styles
├── index.js               # Entry point for the React app
├── index.css              # Additional styles
server.js                  # Handles the backend socket server
socket.js                  # Initializes the socket connection
.env                       # Environment variables for backend URL and configuration
```

## Dependencies

The following dependencies are used in this project:

- `"codemirror": "^5.65.2"`
- `"nodemon": "^3.1.7"`
- `"react": "^18.3.1"`
- `"react-avatar": "^5.0.3"`
- `"react-dom": "^18.3.1"`
- `"react-hot-toast": "^2.4.1"`
- `"react-router-dom": "^6.26.2"`
- `"react-scripts": "5.0.1"`
- `"socket.io": "^4.8.0"`
- `"socket.io-client": "^4.8.0"`
- `"uuid": "^10.0.0"`
- `"web-vitals": "^2.1.4"`

## Environment Variables

The application uses a `.env` file to store environment variables. Ensure the following variable is configured:

```
REACT_APP_BACKEND_URL=<your-backend-url>
```

## Usage

1. **Home Page** (`Home.js`):
   - Users can either create a new room by generating a unique Room ID or join an existing room by entering the Room ID and their username. Room navigation and handling are done via React Router and toast notifications.

2. **Editor Page** (`EditorPage.js`):
   - The page initializes WebSocket connections using `socket.js`, handles user connections/disconnections, and synchronizes code in real time between all users in a room. It includes an `Editor.js` component, where Codemirror is used to create the code editor.

3. **Client Component** (`Client.js`):
   - Displays user avatars and their usernames within the active room.

4. **Editor Component** (`Editor.js`):
   - This component integrates Codemirror, handles code changes, and emits events to synchronize code across connected clients.

5. **Socket Initialization** (`socket.js`):
   - Establishes WebSocket connections with a backend using the URL provided in the `.env` file.

## How to Run

1. Clone the repository:
   ```bash
   git clone <repo-url>
   cd cloud-editor
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Set up the environment variables in a `.env` file:
   ```bash
   REACT_APP_BACKEND_URL=[<your-backend-url>](https://code-editor-f145.onrender.com/)
   ```

4. Run the application:
   ```bash
   npm start
   ```

   The app will run on [http://localhost:3000](http://localhost:3000) by default.

## License

This project is licensed under the MIT License.

---

Let me know if you need any adjustments!
