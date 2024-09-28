import React, { useEffect, useRef } from "react";
import Codemirror from "codemirror";
import "codemirror/mode/javascript/javascript";
import "codemirror/addon/edit/closebrackets";
import "codemirror/addon/edit/closetag";
import "codemirror/lib/codemirror.css";
import "codemirror/theme/dracula.css";
import ACTIONS from "../Actions";
const Editor = ({ socketRef, roomId, onCodeChange}) => {
  const editorRef = useRef(null);
  // initializing code editor
  useEffect(() => {
    async function init() {
      editorRef.current = Codemirror.fromTextArea(
        document.getElementById("realtimeEditor"),
        {
          mode: { name: "javascript", json: true },
          // to enable the above option you have to import css
          autoCloseTags: true,
          theme: "dracula",
          autoCloseBrackets: true,
          lineNumbers: true,
        }
      );

      // changes will be reflected on console
      // event emitted for changing the code
      editorRef.current.on("change", (instance, changes) => {
        // console.log('changes',changes);
        const { origin } = changes;
        const code = instance.getValue();
        onCodeChange(code);
        if (origin !== "setValue") {
          socketRef.current.emit(ACTIONS.CODE_CHANGE, {
            roomId,
            code,
          });
        }
        // console.log(code);
      });
    }
    init(); 
    // eslint-disable-next-line
  }, []);
  // [] :  one time call , when the component is beign rendered for the first time

  useEffect(() => {
    // listening for CODE_CHANGE event
    // recieving the changed code
    console.log("second useEffect")
    if (socketRef.current) {
      socketRef.current.on(ACTIONS.CODE_CHANGE, ({ code }) => {
        // if code is null then it will get deleted from the editor
        if (code !== null) {
          // dynamically adding text to editor
          editorRef.current.setValue(code);
        }
      });
    }

    return ()=>{
      // eslint-disable-next-line
      socketRef.current.off(ACTIONS.CODE_CHANGE);
    }
    // eslint-disable-next-line   
  }, [socketRef.current]);

  return <textarea id="realtimeEditor"></textarea>;
};

export default Editor;
