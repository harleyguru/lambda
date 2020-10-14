/* eslint-disable no-unused-vars */
/* eslint-disable no-console */
const path = require('path')
const { copySync } = require('fs-extra')
const { Component } = require('@serverless/core')
const aws = require('@serverless/aws-sdk-extra')
const {
  prepareInputs,
  getClients,
  createLambdaFunction,
  updateLambdaFunctionCode,
  updateLambdaFunctionConfig,
  getLambdaFunction,
  createOrUpdateFunctionRole,
  createOrUpdateMetaRole,
  deleteLambdaFunction,
  removeAllRoles,
  getMetrics
} = require('./utils')

class AwsLambda extends Component {
  validate(inputs) {
    if (!inputs.schedule) {
      return
    }
    const { rate, enabled, input } = inputs.schedule

    let valid = false

    // Check for a cron expression
    const cronRegex = /^cron\(((((\d+,)+\d+|(\d+(\/|-|#)\d+)|\d+L?|\*(\/\d+)?|L(-\d+)?|\?|[A-Z]{3}(-[A-Z]{3})?) ?){5,7})\)$/
    if (cronRegex.test(rate)) {
      valid = true
    }

    // Check for a rate expression
    const rateRegex = /rate\(\d+\s+(minute|minutes|hour|hours|day|days)\)/
    if (rateRegex.test(rate)) {
      valid = true
    }

    if (!valid) {
      throw new Error('Schedule expression is invalid. Please recheck it.')
    }

    if (enabled && typeof enabled !== 'boolean') {
      throw new Error('schedule enabled is invalid. It should be true or false')
    }

    if (input && typeof input !== 'object') {
      throw new Error('Schedule input is invalid. It should be a valid object.')
    }
  }
  /**
   * Deploy
   * @param {*} inputs
   */
  async deploy(inputs = {}) {
    // this error message assumes that the user is running via the CLI though...
    if (Object.keys(this.credentials.aws).length === 0) {
      const msg = `Credentials not found. Make sure you have a .env file in the cwd. - Docs: https://git.io/JvArp`
      throw new Error(msg)
    }
    this.validate(inputs)

    // Check size of source code is less than 100MB
    if (this.size > 100000000) {
      throw new Error(
        'Your AWS Lambda source code size must be less than 100MB.  Try using Webpack, Parcel, AWS Lambda layers to reduce your code size.'
      )
    }

    // Prepare inputs
    inputs = prepareInputs(inputs, this)

    console.log(
      `Starting deployment of AWS Lambda "${inputs.name}" to the AWS region "${inputs.region}".`
    )

    // Get AWS clients
    const clients = getClients(this.credentials.aws, inputs.region)

    // Throw error on name change
    if (this.state.name && this.state.name !== inputs.name) {
      throw new Error(
        `Changing the name from ${this.state.name} to ${inputs.name} will delete the AWS Lambda function.  Please remove it manually, change the name, then re-deploy.`
      )
    }
    // Throw error on region change
    if (this.state.region && this.state.region !== inputs.region) {
      throw new Error(
        `Changing the region from ${this.state.region} to ${inputs.region} will delete the AWS Lambda function.  Please remove it manually, change the region, then re-deploy.`
      )
    }

    await Promise.all([
      createOrUpdateFunctionRole(this, inputs, clients),
      createOrUpdateMetaRole(this, inputs, clients, this.accountId)
    ])

    console.log(
      `Checking if an AWS Lambda function has already been created with name: ${inputs.name}`
    )
    const prevLambda = await getLambdaFunction(clients.lambda, inputs.name)

    const filesPath = await this.unzip(inputs.src, true) // Returns directory with unzipped files

    if (!inputs.src) {
      copySync(path.join(__dirname, '_src'), filesPath)
      inputs.handler = 'handler.handler'
    }

    inputs.handler = this.addSDK(filesPath, inputs.handler) // Returns new handler
    inputs.src = await this.zip(filesPath, true) // Returns new zip

    // Create or update Lambda function
    if (!prevLambda) {
      // Create a Lambda function
      console.log(
        `Creating a new AWS Lambda function "${inputs.name}" in the "${inputs.region}" region.`
      )
      const createResult = await createLambdaFunction(this, clients.lambda, inputs)
      inputs.arn = createResult.arn
      inputs.hash = createResult.hash
      console.log(`Successfully created an AWS Lambda function`)
    } else {
      // Update a Lambda function
      inputs.arn = prevLambda.arn
      console.log(`Updating ${inputs.name} AWS lambda function.`)
      await updateLambdaFunctionCode(clients.lambda, inputs)
      await updateLambdaFunctionConfig(this, clients.lambda, inputs)
      console.log(`Successfully updated AWS Lambda function`)
    }

    // Update state
    this.state.name = inputs.name
    this.state.arn = inputs.arn
    this.state.region = inputs.region
    const region = inputs.region || 'us-east-1'

    // handle lambda cron
    if (inputs.schedule) {
      const rate = inputs.schedule.rate || null
      const enabled = inputs.schedule.enabled || true
      const input = inputs.schedule.input || null

      const cwEvents = new aws.CloudWatchEvents({
        credentials: this.credentials.aws,
        region
      })

      if (enabled) {
        // create CloudWatch event rule
        const putRuleParams = {
          Name: `${inputs.name}-rule`,
          ScheduleExpression: rate,
          Description: `Lambda-Cron schedule rule for ${inputs.name}`
        }

        const { RuleArn } = await cwEvents.putRule(putRuleParams).promise()
        this.state.cloudWatchRule = putRuleParams.Name

        // add the permission to invoke created lambda function to rule
        const lambda = new aws.Lambda({
          credentials: this.credentials.aws,
          region
        })
        const lambdaPermissions = {
          StatementId: `${inputs.name}-lambda-permission`,
          FunctionName: inputs.name,
          Action: 'lambda:InvokeFunction',
          Principal: 'events.amazonaws.com',
          SourceArn: RuleArn
        }

        try {
          await lambda.addPermission(lambdaPermissions).promise()
        } catch (error) {
          console.log('CloudWatch Events permission already added to lambda, continuing')
        }

        // add target to rule
        const targetParams = {
          Rule: putRuleParams.Name,
          Targets: [
            {
              Arn: inputs.arn,
              Id: `${inputs.name}-target`
            }
          ]
        }
        if (input) {
          targetParams.Targets[0].Input = JSON.stringify(input)
        }
        const response = await cwEvents.putTargets(targetParams).promise()
        this.state.targetId = targetParams.Targets.Id
      } else {
        if (this.state.cloudWatchRule) {
          await cwEvents.deleteRule(this.state.cloudWatchRule)
        }
      }
    }

    return {
      name: inputs.name,
      arn: inputs.arn,
      securityGroupIds: inputs.securityGroupIds,
      subnetIds: inputs.subnetIds
    }
  }

  /**
   * Remove
   * @param {*} inputs
   */
  async remove(inputs = {}) {
    // this error message assumes that the user is running via the CLI though...
    if (Object.keys(this.credentials.aws).length === 0) {
      const msg = `Credentials not found. Make sure you have a .env file in the cwd. - Docs: https://git.io/JvArp`
      throw new Error(msg)
    }

    if (!this.state.name) {
      console.log(`No state found.  Function appears removed already.  Aborting.`)
      return
    }

    const clients = getClients(this.credentials.aws, this.state.region)

    await removeAllRoles(this, clients)

    console.log(`Removing lambda ${this.state.name} from the ${this.state.region} region.`)
    await deleteLambdaFunction(clients.lambda, this.state.name)
    console.log(
      `Successfully removed lambda ${this.state.name} from the ${this.state.region} region.`
    )

    const region = this.state.region || 'us-east-1'
    const cwEvents = new aws.CloudWatchEvents({
      credentials: this.credentials.aws,
      region
    })
    await cwEvents.deleteRule(this.state.cloudWatchRule)

    this.state = {}
    return {}
  }

  /**
   * Metrics
   */
  async metrics(inputs = {}) {
    // Validate
    if (!inputs.rangeStart || !inputs.rangeEnd) {
      throw new Error('rangeStart and rangeEnd are require inputs')
    }

    const result = await getMetrics(
      this.state.region,
      this.state.metaRoleArn,
      this.state.name,
      inputs.rangeStart,
      inputs.rangeEnd
    )

    return result
  }
}

/**
 * Exports
 */
module.exports = AwsLambda
