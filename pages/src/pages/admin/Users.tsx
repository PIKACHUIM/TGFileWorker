import { useEffect, useState } from 'react'
import { Table, Button, Modal, Input, Form, message, Typography, Tag, Popconfirm } from 'antd'
import { DeleteOutlined, KeyOutlined } from '@ant-design/icons'
import { getUsers, deleteUser, updateUserPassword } from '../../api'
import type { User } from '../../api'

export default function Users() {
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(false)
  const [pwdModal, setPwdModal] = useState<{ open: boolean; user: User | null }>({ open: false, user: null })
  const [pwdLoading, setPwdLoading] = useState(false)
  const [pwdForm] = Form.useForm()

  // 获取当前登录用户ID
  const currentUserId = (() => {
    try {
      const token = localStorage.getItem('token')
      if (!token) return null
      const payload = JSON.parse(atob(token.split('.')[1]))
      return payload.userId as number
    } catch { return null }
  })()

  function loadUsers() {
    setLoading(true)
    getUsers().then(r => setUsers(r.data)).catch(() => message.error('获取用户列表失败')).finally(() => setLoading(false))
  }

  useEffect(() => { loadUsers() }, [])

  async function onDelete(id: number) {
    try {
      await deleteUser(id)
      message.success('删除成功')
      loadUsers()
    } catch (err: any) {
      message.error(err.response?.data?.error || '删除失败')
    }
  }

  async function onUpdatePassword() {
    if (!pwdModal.user) return
    try {
      const vals = await pwdForm.validateFields()
      setPwdLoading(true)
      await updateUserPassword(pwdModal.user.id, vals.password)
      message.success('密码修改成功')
      setPwdModal({ open: false, user: null })
      pwdForm.resetFields()
    } catch (err: any) {
      if (err.response) message.error(err.response?.data?.error || '修改失败')
    } finally {
      setPwdLoading(false)
    }
  }

  const columns = [
    {
      title: '用户名',
      dataIndex: 'username',
      key: 'username',
    },
    {
      title: '邮箱',
      dataIndex: 'email',
      key: 'email',
      render: (v: string | null) => v || '-',
    },
    {
      title: '角色',
      dataIndex: 'role',
      key: 'role',
      render: (role: string) => (
        <Tag color={role === 'admin' ? 'red' : 'blue'}>
          {role === 'admin' ? '管理员' : '普通用户'}
        </Tag>
      ),
    },
    {
      title: '注册时间',
      dataIndex: 'created_at',
      key: 'created_at',
      render: (v: number) => new Date(v * 1000).toLocaleString(),
    },
    {
      title: '操作',
      key: 'actions',
      render: (_: unknown, record: User) => (
        <>
          <Button
            icon={<KeyOutlined />}
            size="small"
            onClick={() => setPwdModal({ open: true, user: record })}
          >
            改密
          </Button>
          {record.id !== currentUserId && (
            <Popconfirm
              title="确定删除该用户？"
              onConfirm={() => onDelete(record.id)}
              okText="确定"
              cancelText="取消"
            >
              <Button icon={<DeleteOutlined />} size="small" danger style={{ marginLeft: 8 }}>
                删除
              </Button>
            </Popconfirm>
          )}
        </>
      ),
    },
  ]

  return (
    <div>
      <Typography.Title level={4}>用户管理</Typography.Title>
      <Table
        rowKey="id"
        columns={columns}
        dataSource={users}
        loading={loading}
        pagination={false}
      />

      <Modal
        title={`修改密码 - ${pwdModal.user?.username ?? ''}`}
        open={pwdModal.open}
        onOk={onUpdatePassword}
        onCancel={() => { setPwdModal({ open: false, user: null }); pwdForm.resetFields() }}
        confirmLoading={pwdLoading}
      >
        <Form form={pwdForm} layout="vertical">
          <Form.Item name="password" label="新密码" rules={[
            { required: true, message: '请输入新密码' },
            { min: 6, message: '密码长度不能少于6位' },
          ]}>
            <Input.Password />
          </Form.Item>
          <Form.Item name="confirm" label="确认密码" dependencies={['password']} rules={[
            { required: true, message: '请确认密码' },
            ({ getFieldValue }) => ({
              validator(_, value) {
                if (!value || getFieldValue('password') === value) return Promise.resolve()
                return Promise.reject(new Error('两次密码不一致'))
              },
            }),
          ]}>
            <Input.Password />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  )
}
