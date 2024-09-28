import React from 'react'
import Avatar from 'react-avatar'
const Client = (props) => {
  return (
    <div className="client">
      <Avatar name={props.username} size={40} round="14px"/>
      <span className="username">
        {props.username}
      </span>
    </div>
  )
}

export default Client